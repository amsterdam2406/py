"""
Image processing utilities for attendance photo handling
- Image compression
- Validation
- Security checks
"""

import io
import base64
import logging
from uuid import uuid4

from PIL import Image, ImageOps
from django.core.files.base import ContentFile
from django.core.exceptions import ValidationError

# Prevent decompresion bomb attacks
Image.MAX_IMAGE_PIXELS = 20_000_000

logger = logging.getLogger(__name__)

# Image configuration
MAX_IMAGE_SIZE = 5 * 1024 * 1024  # 10MB
ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
MAX_IMAGE_DIMENSION = 1920  # Max width/height in pixels
COMPRESSION_QUALITY = 85


def validate_image_data_url(data_url: str) -> tuple:
    """
    Validate and extract image data from base64 data URL

    Returns:
        tuple: (image_type, base64_data)
    """
    try:
        if not data_url or not data_url.startswith('data:'):
            raise ValidationError("Invalid image format")

        header, data = data_url.split(';base64,', 1)
        image_type = header.replace('data:', '')

        if image_type not in ALLOWED_IMAGE_TYPES:
            raise ValidationError(
                f"Invalid image type. Allowed types: {', '.join(ALLOWED_IMAGE_TYPES)}"
            )

        return image_type, data

    except (ValueError, IndexError):
        raise ValidationError("Malformed base64 image data")


def compress_and_validate_image(data_url: str) -> ContentFile:
    """
    Validate, process, and compress a base64 image.

    Returns:
        ContentFile (JPEG)
    """
    try:
        # Validate data URL
        image_type, imgstr = validate_image_data_url(data_url)

        # Decode base64
        try:
            image_data = base64.b64decode(imgstr)
        except Exception:
            logger.error("Failed to decode base64 image data")
            raise ValidationError("Invalid base64 data")

        # Size check (before processing)
        if len(image_data) > MAX_IMAGE_SIZE:
            raise ValidationError(f"Image size exceeds {MAX_IMAGE_SIZE} bytes")

        # Open and verify image
        try:
            image = Image.open(io.BytesIO(image_data))
            image.verify()  # Validate integrity
            image = Image.open(io.BytesIO(image_data))  # Reopen after verify
        except Exception:
            logger.error("Invalid or corrupted image file")
            raise ValidationError("Invalid or corrupted image file")

        # Fix EXIF orientation (important for mobile uploads)
        image = ImageOps.exif_transpose(image)

        # Resize if needed
        if image.width > MAX_IMAGE_DIMENSION or image.height > MAX_IMAGE_DIMENSION:
            original_size = image.size
            image.thumbnail(
                (MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION),
                Image.Resampling.LANCZOS,
            )
            logger.info(f"Image resized from {original_size} to {image.size}")

        # Convert to RGB (required for JPEG)
        if image.mode in ('RGBA', 'LA', 'P'):
            if image.mode == 'P':
                image = image.convert('RGBA')

            background = Image.new('RGB', image.size, (255, 255, 255))
            background.paste(image, mask=image.split()[-1])
            image = background

        # Compress to JPEG (standardize output)
        output = io.BytesIO()
        image.save(
            output,
            format='JPEG',
            quality=COMPRESSION_QUALITY,
            optimize=True,
            progressive=True
        )

        output.seek(0)
        compressed_data = output.read()

        # Final size check
        if len(compressed_data) > MAX_IMAGE_SIZE:
            raise ValidationError(
                f"Compressed image exceeds limit. "
                f"Original: {len(image_data) / 1024:.0f}KB, "
                f"Compressed: {len(compressed_data) / 1024:.0f}KB"
            )

        # Create Django file
        file = ContentFile(compressed_data, name=f"{uuid4().hex}.jpg")

        # Logging
        logger.info(
            f"Image processed successfully: "
            f"{len(image_data)//1024}KB -> {len(compressed_data)//1024}KB"
        )

        return file

    except ValidationError:
        raise
    except Exception as e:
        logger.error(f"Image processing error: {str(e)}")
        raise ValidationError("Failed to process image")


def get_image_info(image_file) -> dict:
    """
    Get metadata about an image file
    """
    try:
        image = Image.open(image_file)

        return {
            'format': image.format,
            'size': image.size,
            'mode': image.mode,
            'file_size': getattr(image_file, 'size', 0),
        }

    except Exception as e:
        logger.error(f"Failed to get image info: {str(e)}")
        return {}