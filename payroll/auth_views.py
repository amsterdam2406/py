import logging
from decimal import Decimal
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken
from django.contrib.auth import authenticate
from django.contrib.auth import get_user_model
from django.db import transaction, models
from django.db.utils import IntegrityError
from django.utils import timezone
from django.utils.http import urlsafe_base64_encode, urlsafe_base64_decode
from django.utils.encoding import force_bytes, force_str
from django.contrib.auth.tokens import default_token_generator
from django.core.exceptions import ValidationError
from .models import Employee, User, Notification
from .utils import log_audit
from django.contrib.auth.password_validation import validate_password
from django.core.mail import send_mail
from django.template.loader import render_to_string
from django.utils.html import strip_tags
from django.urls import reverse
from django.conf import settings
from django.db.models import Q

from rest_framework_simplejwt.views import TokenRefreshView
from rest_framework_simplejwt.serializers import TokenRefreshSerializer
from rest_framework_simplejwt.exceptions import InvalidToken
from rest_framework.views import APIView
from .serializers import UserSerializer
from .throttles import LoginThrottle
import re


logger = logging.getLogger(__name__)
User = get_user_model()

class CurrentUserView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        serializer = UserSerializer(request.user)
        return Response(serializer.data)

class CookieTokenRefreshSerializer(TokenRefreshSerializer):
    refresh = None
    def validate(self, attrs):
        # Try cookie first, then request body for SPA compatibility
        request = self.context['request']
        refresh_token = request.COOKIES.get('refresh_token') or request.data.get('refresh')
        if refresh_token:
            attrs['refresh'] = refresh_token
            return super().validate(attrs)
        else:
            raise InvalidToken('No valid token found in cookie or body')

class CookieTokenRefreshView(TokenRefreshView):
    serializer_class = CookieTokenRefreshSerializer
    permission_classes = [AllowAny]

    def post(self, request, *args, **kwargs):
        response = super().post(request, *args, **kwargs)
        # Also set new refresh token in cookie if provided
        if 'refresh' in response.data:
            response.set_cookie(
                key='refresh_token',
                value=response.data['refresh'],
                httponly=True,
        secure=not settings.DEBUG,
                path="/"
            )
        return response

@api_view(['POST'])
@permission_classes([AllowAny])
@throttle_classes([LoginThrottle])
def login_view(request):
    """Login endpoint - returns both tokens in body for SPA storage"""
    username = request.data.get('username')
    password = request.data.get('password')
    
    try:
        if not username or not password:
            return Response(
                {'error': 'Username and password are required'},
                status=status.HTTP_400_BAD_REQUEST
            )
            
        user = authenticate(request, username=username, password=password)
        
        if not user:
            logger.warning(f"Failed login attempt for {username} from {request.META.get('REMOTE_ADDR')}")
            return Response(
                {'error': 'Invalid credentials'},
                status=status.HTTP_401_UNAUTHORIZED
            )
            
        logger.info(f"Successful login for {username} from {request.META.get('REMOTE_ADDR')}")
            
        # This is where 500s often happen if SimpleJWT migrations aren't run
        refresh = RefreshToken.for_user(user)
            
        # Get employee_id safely
        employee_id = None
        try:
            if hasattr(user, 'employee_profile'):
                employee_id = user.employee_profile.employee_id
        except Exception as profile_err:
            logger.error(f"Error accessing employee profile for {username}: {profile_err}")

        response = Response({
            'access': str(refresh.access_token),
            'refresh': str(refresh),
            'user': {
                'id': user.id,
                'username': user.username,
                'email': user.email,
                'role': user.role,
                'employee_id': employee_id,
                'first_name': user.first_name,
                'last_name': user.last_name,
                'is_superuser': user.is_superuser,
                'is_company_admin': getattr(user, 'is_company_admin', False),
                'is_payment_admin': getattr(user, 'is_payment_admin', False),
                'is_deduction_admin': getattr(user, 'is_deduction_admin', False),
                'is_employee_admin': getattr(user, 'is_employee_admin', False),
            }
        }, status=status.HTTP_200_OK)

        # Also set refresh token in HttpOnly cookie as backup
        response.set_cookie(
            key='refresh_token',
            value=str(refresh),
            httponly=True,
            secure=not settings.DEBUG,
            samesite='Lax',
            path="/"
        )

        return response

    except Exception as e:
        logger.error(f"CRITICAL LOGIN ERROR for {username}: {str(e)}", exc_info=True)
        return Response(
            {'error': 'An internal server error occurred during login.'},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def register_view(request):
    data = request.data
    username = data.get('username')
    password = data.get('password')
    role = data.get('role', 'staff')
    first_name = data.get('first_name')
    last_name = data.get('last_name')
    full_name = (data.get('full_name') or '').strip()
    current_user = request.user
    employee_id = data.get('employee_id')  # May be provided from frontend
        # Role validation
    if role not in ['admin', 'staff', 'guard']:
        return Response(
            {'error': 'Invalid role. Must be admin, staff, or guard'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    if current_user.is_superuser:
        pass
    else:
        if current_user.role == 'admin' and role == 'admin':
            return Response(
                {'error': 'Admin users cannot create other admin users'},
                status=status.HTTP_403_FORBIDDEN
            )
        if current_user.role in ['staff', 'guard']:
            return Response(
                {'error': 'Only admin users can create new users'},
                status=status.HTTP_403_FORBIDDEN
            )
    
    if not username or not password:
        return Response(
            {'error': 'Username and password are required'}, 
            status=status.HTTP_400_BAD_REQUEST
        )
    
    try:
        validate_password(password)
    except ValidationError as e:
        return Response(
            {'error': e.messages},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    # DUPLICATE DETECTION: Check username
    if User.objects.filter(username=username).exists():
        return Response(
            {'error': 'Username already exists', 'field': 'username'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    # DUPLICATE DETECTION: Check email if provided
    email = data.get('email')
    if email and User.objects.filter(email__iexact=email).exists():
        return Response(
            {'error': 'Email already registered', 'field': 'email'},
            status=status.HTTP_400_BAD_REQUEST
        )
    
    # DUPLICATE DETECTION: Check account number if provided
    account_number = data.get('account_number')
    bank_name = data.get('bank_name')
    if account_number and bank_name:
        if Employee.objects.filter(
            account_number=account_number,
            bank_name=bank_name,
            status__in=['active', 'terminated']  # Check active and terminated
        ).exists():
            return Response(
                {
                    'error': 'Bank account already registered to another employee',
                    'field': 'account_number',
                    'message': 'This account number is already in use'
                },
                status=status.HTTP_400_BAD_REQUEST
            )
    
    # Employee validation fields
    if role in ['staff', 'guard']:
        required_fields = ['salary', 'location', 'bank_name', 'account_number', 'account_holder']
        missing = [f for f in required_fields if not data.get(f)]
        if missing:
            return Response(
                {'error': f'Missing required fields: {", ".join(missing)}'},
                status=status.HTTP_400_BAD_REQUEST
            )
    
    try:
        with transaction.atomic():
            if full_name and not first_name and not last_name:
                name_parts = full_name.split(None, 1)
                first_name = name_parts[0]
                last_name = name_parts[1] if len(name_parts) > 1 else ''
            user = User.objects.create_user(
                username=username,
                password=password,
                email=email,
                role=role
            )
            user.first_name = first_name or ''
            user.last_name = last_name or ''
            user.save()
            employee = None
            if role in ['staff', 'guard']:
                employee_name = full_name or f"{first_name or ''} {last_name or ''}".strip() or username

                # Prepare employee data
                employee_data = {
                    'user': user,
                    'name': employee_name,
                    'type': role,
                    'location': data.get('location'),
                    'salary': data.get('salary'),
                    'phone': data.get('phone', ''),
                    'email': email,
                    'bank_name': data.get('bank_name'),
                    'bank_code': data.get('bank_code') or '',
                    'account_number': data.get('account_number'),
                    'account_holder': data.get('account_holder'),
                    'join_date': timezone.now().date(),
                    'status': 'active',
                }

                
                # If employee_id provided (from preview), check it's still available
                if employee_id:
                    if Employee.objects.filter(employee_id=employee_id).exists():
                        # ID was taken, let model generate new one
                        employee_data.pop('employee_id', None)
                    else:
                        employee_data['employee_id'] = employee_id
                
                employee = Employee.objects.create(**employee_data)
                # Refresh to get the actual generated ID
                employee.refresh_from_db()
        return Response(
            {
                'message': 'User created successfully',
                'user': {
                    'id': user.id,
                    'username': user.username,
                    'email': user.email,
                    'role': user.role,
                    'first_name': user.first_name,
                    'last_name': user.last_name,
                },
                'employee': (
                    {
                        'id': str(employee.id),
                        'employee_id': employee.employee_id,
                        'name': employee.name,
                        'type': employee.type,
                        'sequence': employee.id_sequence,
                    } if employee else None
                )
            },
            status=status.HTTP_201_CREATED
        )
    
    except IntegrityError as e:
        logger.error(f"Integrity error during registration: {e}")
        # More specific error messages based on the IntegrityError
        if 'employee_id' in str(e):
            return Response(
                {'error': 'A unique employee ID could not be generated. Please try again.'},
                status=status.HTTP_409_CONFLICT # Use 409 Conflict for resource conflicts
            )
        elif 'account_number' in str(e):
            return Response(
                {'error': 'This bank account number is already registered to another employee.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        elif 'email' in str(e):
            return Response(
                {'error': 'This email is already registered for another employee.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        return Response(
            {'error': 'An integrity error occurred during registration. Please try again.'},
            status=status.HTTP_400_BAD_REQUEST
        )
    except Exception as e:
        logger.error(f"Registration error: {e}")
        return Response(
            {'error': 'Registration failed. Please try again.'},
            status=status.HTTP_400_BAD_REQUEST
        )
@api_view(['POST'])
@permission_classes([IsAuthenticated])
def logout_view(request):
    try:
        refresh_token = request.COOKIES.get('refresh_token') or request.data.get('refresh')
        if refresh_token:
            token = RefreshToken(refresh_token)
            token.blacklist()

        response = Response({"detail": "Successfully logged out."}, status=status.HTTP_200_OK)
        response.delete_cookie('refresh_token')
        return response
    except Exception as e:
        logger.error(f"Logout error: {e}")
        response = Response({"detail": "Logout failed, but cookie cleared."}, status=status.HTTP_400_BAD_REQUEST)
        response.delete_cookie('refresh_token')
        return response

@api_view(['POST'])
@permission_classes([IsAuthenticated])
def verify_password(request):
    """Confirm current password matches input. Used by frontend exports."""
    pwd = request.data.get('password')
    if not pwd:
        return Response({'error': 'Password is required'}, status=status.HTTP_400_BAD_REQUEST)
    if request.user.check_password(pwd):
        return Response({'valid': True}, status=status.HTTP_200_OK)
    return Response({'valid': False}, status=status.HTTP_401_UNAUTHORIZED)


    # NEW: Endpoint to get next employee ID for preview
@api_view(['GET'])
@permission_classes([AllowAny])
def get_next_employee_id(request):
    """Get next auto-generated employee ID for preview (does NOT reserve it)"""
    employee_type = request.query_params.get('type', 'staff')
    
    # Get the last sequence used globally
    last_employee = Employee.objects.order_by('-id_sequence').first()
    next_sequence = (last_employee.id_sequence + 1) if last_employee and last_employee.id_sequence else 1
    
    # Format preview ID
    if employee_type == 'staff':
        suffix = 'STAFF'
    elif employee_type == 'guard':
        suffix = 'GRD'
    else:
        suffix = 'EMP'
    
    next_id = f"FSS-{str(next_sequence).zfill(3)}-{suffix}"
    
    return Response({
        'next_id': next_id,
        'type': employee_type,
        'sequence': next_sequence,
        'note': 'This is a preview. Actual ID assigned on creation.'
    }, status=status.HTTP_200_OK)

@api_view(['POST'])
@permission_classes([AllowAny])
def self_register_employee(request):
    """Self signup for staff/guards - sets as pending for admin approval"""
    data = request.data
    
    required = ['username', 'password', 'full_name', 'role', 'email', 'location']
    missing = [f for f in required if not data.get(f)]
    if missing:
        return Response({'error': f'Missing: {", ".join(missing)}'}, status=status.HTTP_400_BAD_REQUEST)
    
    role_type = data.get('role')
    if role_type not in ['staff', 'guard']:
        return Response({'error': 'Role must be staff or guard'}, status=status.HTTP_400_BAD_REQUEST)
        
    if User.objects.filter(username=data['username']).exists():
        return Response({'error': 'Username already exists', 'field': 'username'}, status=status.HTTP_400_BAD_REQUEST)

    if User.objects.filter(email__iexact=data['email']).exists():
        return Response({'error': 'Email already registered', 'field': 'email'}, status=status.HTTP_400_BAD_REQUEST)

    try:
        with transaction.atomic():
            name_parts = data['full_name'].split(None, 1)
            first_name = name_parts[0]
            last_name = name_parts[1] if len(name_parts) > 1 else ''
            
            user = User.objects.create_user(
                username=data['username'],
                password=data['password'],
                email=data['email'].lower(),
                role=role_type,
                first_name=first_name,
                last_name=last_name,
            )
            user.is_active = False # Requires admin approval
            user.save()

            employee = Employee.objects.create(
                user=user,
                name=data['full_name'],
                type=role_type,
                location=data['location'],
                salary=Decimal(str(data.get('salary', 0))),
                phone=data.get('phone', ''),
                email=data['email'],
                bank_name=data.get('bank_name', ''),
                account_number=data.get('account_number', ''),
                account_holder=data.get('account_holder', ''),
                is_self_registered=True,
                status='pending',
                join_date=timezone.now().date()
            )
            employee.refresh_from_db()
            
        send_registration_notifications(employee, request)
    except IntegrityError as e: # Add specific handling here
        logger.error(f"Integrity error during self-registration: {e}")
        if 'employee_id' in str(e):
            return Response(
                {'error': 'A unique employee ID could not be generated. Please try again.'},
                status=status.HTTP_409_CONFLICT
            )
        elif 'account_number' in str(e):
            return Response(
                {'error': 'This bank account number is already registered.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        elif 'email' in str(e):
            return Response(
                {'error': 'This email is already registered.'},
                status=status.HTTP_400_BAD_REQUEST
            )
        return Response(
            {'error': 'Self-registration failed due to a data conflict. Please try again.'},
            status=status.HTTP_400_BAD_REQUEST
        )

        logger.info(f"Self-signup {role_type} successful: {user.username} (ID: {employee.employee_id})")
        return Response({
            'message': 'Account created! Your registration is pending admin approval.',
            'employee_id': employee.employee_id,
            'username': user.username
        }, status=status.HTTP_201_CREATED)
    except Exception as e:
        logger.error(f"Self-registration error: {e}")
        return Response({'error': 'Registration failed. Please try again.'}, status=status.HTTP_400_BAD_REQUEST)
    
def send_registration_notifications(employee, request):
    """Utility to send HTML emails to admin and employee"""
    user = employee.user
    role = employee.type
    
    # Admin Alert
    admins = User.objects.filter(Q(is_superuser=True) | Q(role='admin'))
    admin_emails = [a.email for a in admins if a.email]
    
    if admin_emails:
        admin_subject = f"New Registration: {employee.name} ({role.upper()})"
        context = {
            'name': employee.name,
            'username': user.username,
            'role': role.title(),
            'email': user.email,
            'location': employee.location,
            'site_url': request.build_absolute_uri('/')
        }
        html_message = render_to_string('emails/admin_registration_alert.html', context)
        send_mail(
            admin_subject, strip_tags(html_message),
            settings.DEFAULT_FROM_EMAIL, admin_emails,
            html_message=html_message, fail_silently=True
        )

    # Employee Confirmation
    site_url = request.build_absolute_uri('/')
    user_subject = "Registration Received - Fotasco Payroll"
    user_context = {
        'name': employee.name,
        'site_url': site_url,
        'reset_link': f"{site_url}#/password-reset"
    }
    user_html = render_to_string('emails/user_registration_confirmation.html', user_context)
    send_mail(
        user_subject, strip_tags(user_html),
        settings.DEFAULT_FROM_EMAIL, [user.email],
        html_message=user_html, fail_silently=True
    )

@api_view(['POST'])
@permission_classes([AllowAny])
@throttle_classes([LoginThrottle])
def request_password_reset(request):
    """Secure password reset request - blocks inactive/pending users"""
    email = request.data.get('email')
    if not email:
        return Response({'error': 'Email is required'}, status=status.HTTP_400_BAD_REQUEST)

    user = User.objects.filter(email__iexact=email).first()

    if user:
        # SECURITY: Restricted access for inactive or pending accounts
        if not user.is_active:
            logger.warning(f"Blocked password reset attempt for inactive user: {email}")
            return Response({
                'error': 'Account access is restricted. Please contact an administrator.'
            }, status=status.HTTP_403_FORBIDDEN)

        # Generate Token and UID
        token = default_token_generator.make_token(user)
        uid = urlsafe_base64_encode(force_bytes(user.pk))
        
        # SECURITY FIX: Point the link to the Frontend SPA homepage with action parameters.
        # The script.js bootstrap logic detects these params to open the reset modal.
        reset_url = f"{request.build_absolute_uri('/')}?action=reset-password&uid={uid}&token={token}"

        # Send Email
        subject = "Password Reset Request - Fotasco Payroll"
        html_message = f"Hello {user.username},<br><br>Please click the link below to reset your password:<br><a href='{reset_url}'>{reset_url}</a><br><br>This link expires in 24 hours."
        
        send_mail(
            subject,
            strip_tags(html_message),
            settings.DEFAULT_FROM_EMAIL,
            [user.email],
            html_message=html_message,
            fail_silently=False
        )
        
        logger.info(f"Password reset initiated for: {email}")

    # Return generic success for security (preventing account enumeration)
    return Response({'message': 'If an active account exists with this email, you will receive a reset link.'})


@api_view(['POST'])
@permission_classes([AllowAny])
@throttle_classes([LoginThrottle])
def reset_password_confirm(request, uidb64, token):
    """Confirm reset token and update password"""
    password = request.data.get('password')
    if not password:
        return Response({'error': 'New password is required'}, status=400)

    try:
        uid = force_str(urlsafe_base64_decode(uidb64))
        user = User.objects.get(pk=uid)
    except (TypeError, ValueError, OverflowError, User.DoesNotExist):
        return Response({'error': 'Invalid reset link'}, status=400)

    if default_token_generator.check_token(user, token):
        try:
            validate_password(password, user)
        except ValidationError as e:
            return Response({'error': e.messages}, status=400)
            
        user.set_password(password)
        user.save()
        log_audit(user, "Password reset successfully via email token", request)
        logger.info(f"Password successfully reset for user: {user.username}")
        return Response({'message': 'Password has been reset successfully.'})
    
    return Response({'error': 'The reset link is invalid or has expired.'}, status=400)

@api_view(['POST'])
@permission_classes([IsAuthenticated])
def change_password(request):
    """Change user password with confirmation and superuser notification"""
    user = request.user
    old_password = request.data.get('old_password')
    new_password = request.data.get('new_password')
    confirm_password = request.data.get('confirm_password')
    
    if not old_password or not new_password or not confirm_password:
        return Response({'error': 'All password fields are required'}, status=status.HTTP_400_BAD_REQUEST)
    
    if new_password != confirm_password:
        return Response({'error': 'New passwords do not match'}, status=status.HTTP_400_BAD_REQUEST)
    
    if not user.check_password(old_password):
        return Response({'error': 'Current password is incorrect'}, status=status.HTTP_400_BAD_REQUEST)
    
    # Validate new password strength
    try:
        validate_password(new_password, user)
    except Exception as e:
        return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)
    
    # Change password
    user.set_password(new_password)
    user.save()
    
    log_audit(
        user, 
        "User manually changed their password", 
        request
    )
    
    # Notify superuser
    superusers = User.objects.filter(is_superuser=True)
    for superuser in superusers:
        Notification.objects.create(
            user=superuser,
            message=f'Security Alert: User {user.username} ({user.get_full_name() or user.email}) has changed their password.',
            type='info'
        )
    
    # Log the change
    logger.info(f"Password changed for user {user.username} by {request.user.username}")
    
    return Response({'message': 'Password changed successfully'}, status=status.HTTP_200_OK)
