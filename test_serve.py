import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import serve


class LaunchpadPageTests(unittest.TestCase):
    url = serve.LP_API + "ubuntu/+archive/primary"

    def response(self, page):
        return io.BytesIO(json.dumps(page).encode())

    def error(self, code):
        return HTTPError(self.url, code, "upstream error", {}, None)

    @patch("serve.time.sleep")
    @patch("serve.urllib.request.urlopen")
    def test_transient_gateway_errors_recover(self, urlopen, sleep):
        for code in (502, 503, 504):
            with self.subTest(code=code):
                urlopen.reset_mock()
                sleep.reset_mock()
                urlopen.side_effect = [self.error(code), self.response({"entries": []})]
                self.assertEqual(serve._lp_page(self.url), {"entries": []})
                self.assertEqual(urlopen.call_count, 2)
                sleep.assert_called_once_with(1)

    @patch("serve.time.sleep")
    @patch("serve.urllib.request.urlopen")
    def test_persistent_failure_is_bounded(self, urlopen, sleep):
        urlopen.side_effect = [self.error(503) for attempt in range(3)]
        with self.assertRaises(HTTPError) as caught:
            serve._lp_page(self.url)
        self.assertEqual(caught.exception.code, 503)
        self.assertEqual(urlopen.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])

    @patch("serve.time.sleep")
    @patch("serve.urllib.request.urlopen")
    def test_permanent_error_is_not_retried(self, urlopen, sleep):
        urlopen.side_effect = self.error(404)
        with self.assertRaises(HTTPError):
            serve._lp_page(self.url)
        urlopen.assert_called_once_with(self.url, timeout=60)
        sleep.assert_not_called()

    @patch("serve.time.sleep")
    @patch("serve.urllib.request.urlopen")
    def test_later_page_retries_without_losing_versions(self, urlopen, sleep):
        next_url = self.url + "?ws.start=1"
        entry = {
            "pocket": "Updates", "date_published": "2024-06-01T12:00:00+00:00",
            "status": "Published", "binary_package_version": "6.8.0.31.31",
        }
        urlopen.side_effect = [
            self.response({"entries": [entry], "next_collection_link": next_url}),
            self.error(503),
            self.response({"entries": [{**entry, "binary_package_version": "6.8.0.32.32"}]}),
        ]
        with patch.dict(serve._kv_cache, {}, clear=True):
            versions = serve.kernel_versions("noble", "linux-generic")
            self.assertEqual({item["version"] for item in versions}, {"6.8.0.31.31", "6.8.0.32.32"})
            self.assertEqual(serve.kernel_versions("noble", "linux-generic"), versions)
        self.assertEqual(urlopen.call_count, 3)
        self.assertEqual(urlopen.call_args_list[1], urlopen.call_args_list[2])
        sleep.assert_called_once_with(1)


if __name__ == "__main__":
    unittest.main()