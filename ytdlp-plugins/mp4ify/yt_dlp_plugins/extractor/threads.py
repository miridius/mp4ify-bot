import re

from yt_dlp.extractor.instagram import InstagramBaseIE
from yt_dlp.utils import ExtractorError, traverse_obj


class ThreadsIE(InstagramBaseIE):
    IE_NAME = 'threads'
    _VALID_URL = r'https?://(?:www\.)?threads\.(?:com|net)/(?:(?:@[\w.]+/post|t)/(?P<id>[\w-]+)|share/[\w-]+)'

    def _real_extract(self, url):
        sent_id = self.get_temp_id(url) or 'share'
        # Threads serves the post's data only to Chrome's fingerprint
        webpage, urlh = self._download_webpage_handle(
            url, sent_id, impersonate='chrome', require_impersonation=True)
        post_id = self.get_temp_id(urlh.url)
        if not post_id:
            if '/login' in urlh.url:
                raise ExtractorError('Threads did not serve the post (a login wall)', expected=True, video_id=sent_id)
            raise ExtractorError('Threads did not lead to a post', expected=True, video_id=sent_id)
        found = self._find_post(webpage, post_id)
        if not found:
            raise ExtractorError('No post data in the page', expected=True, video_id=post_id)
        post, videos = found
        if not videos:
            raise ExtractorError('There is no video in this post', expected=True, video_id=post_id)

        entries = [self._entry(m, post, post_id) for m in videos]
        if len(entries) == 1:
            return entries[0]
        return self.playlist_result(entries, post_id, entries[0]['title'])

    # the page can hold several copies of the post, not all with its media:
    # prefer the post's own video in any copy over one it borrows
    def _find_post(self, webpage, post_id):
        posts = []
        for blob in re.findall(r'<script[^>]+type="application/json"[^>]*>(.*?)</script>', webpage, re.S):
            for post in self._posts(self._parse_json(blob, post_id, fatal=False), post_id):
                if videos := self._own_videos(post):
                    return post, videos
                posts.append(post)
        for post in posts:
            if videos := self._borrowed_videos(post):
                return post, videos
        return (posts[0], []) if posts else None

    @classmethod
    def _posts(cls, obj, post_id):
        if isinstance(obj, dict):
            if obj.get('code') == post_id and 'media_type' in obj:
                yield obj
            obj = list(obj.values())
        if isinstance(obj, list):
            for v in obj:
                yield from cls._posts(v, post_id)

    @staticmethod
    def _own_videos(post):
        return [m for m in [post, *(post.get('carousel_media') or [])] if m.get('video_versions')]

    @classmethod
    def _borrowed_videos(cls, post):
        info = post.get('text_post_app_info') or {}
        for path in (('linked_inline_media',), *(('share_info', k) for k in ('quoted_post', 'reposted_post', 'quoted_attachment_post'))):
            if (inner := traverse_obj(info, path)) and (videos := cls._own_videos(inner) or cls._borrowed_videos(inner)):
                return videos
        return []

    def _entry(self, media, post, post_id):
        username = traverse_obj(media, ('user', 'username')) or traverse_obj(post, ('user', 'username'))
        entry = {
            'description': traverse_obj(post, ('caption', 'text')),
            'channel': username,
            **self._extract_product_media(media),
        }
        entry['id'] = entry['id'] or post_id
        # parseCaption (src/download-video.ts) shows the description for a title that
        # is the id or starts with 'Video by '
        entry['title'] = f'Video by {username}' if username else entry['id']
        return entry
