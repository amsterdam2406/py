import os

import cloudinary
import cloudinary.uploader
from cloudinary_storage.storage import MediaCloudinaryStorage


class PrivateMediaCloudinaryStorage(MediaCloudinaryStorage):
    """Cloudinary storage for sensitive employee media.

    Files are uploaded as authenticated assets and URLs are signed. This keeps
    direct Cloudinary URLs from becoming public bearer URLs.
    """

    CLOUDINARY_TYPE = 'authenticated'

    def _upload(self, name, content):
        options = {
            'use_filename': True,
            'resource_type': self._get_resource_type(name),
            'tags': self.TAG,
            'type': self.CLOUDINARY_TYPE,
        }
        folder = os.path.dirname(name)
        if folder:
            options['folder'] = folder
        return cloudinary.uploader.upload(content, **options)

    def _get_url(self, name):
        name = self._prepend_prefix(name)
        cloudinary_resource = cloudinary.CloudinaryResource(
            name,
            type=self.CLOUDINARY_TYPE,
            default_resource_type=self._get_resource_type(name),
        )
        return cloudinary_resource.build_url(sign_url=True)

    def delete(self, name):
        response = cloudinary.uploader.destroy(
            name,
            invalidate=True,
            resource_type=self._get_resource_type(name),
            type=self.CLOUDINARY_TYPE,
        )
        return response['result'] == 'ok'
