import io
import json
import http.client
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import serve


class RemoteEnrollmentTests(unittest.TestCase):
    def setUp(self):
        self.conf = tempfile.TemporaryDirectory()
        self.addCleanup(self.conf.cleanup)
        self.server = serve.Server(("127.0.0.1", 0), serve.Handler)
        self.server.conf_dir = self.conf.name
        self.host = "127.0.0.1:%d" % self.server.server_port
        self.server.allowed_hosts = {self.host}
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.run = self.enterContext(patch("serve.subprocess.run"))
        self.enterContext(patch.object(serve.Handler, "log_message"))
        self.body = {"name": "supermicro", "addr": "https://172.16.66.10:8443", "token": "test-token"}

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, body=None, headers=None, raw=None):
        conn = http.client.HTTPConnection(self.host, timeout=5)
        try:
            conn.request("POST", "/_gab/remotes",
                         body=raw if raw is not None else json.dumps(self.body if body is None else body),
                         headers={"Content-Type": "application/json", **(headers or {})})
            response = conn.getresponse()
            self.connection_header = response.getheader("Connection")
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_enrolls_using_configured_lxc_and_token_verification(self):
        self.run.return_value = subprocess.CompletedProcess([], 0, "", "")
        status, body = self.request()
        self.assertEqual((status, body), (201, {"name": "supermicro"}))
        args, kwargs = self.run.call_args
        self.assertEqual(args[0], ["lxc", "remote", "add", "supermicro",
                                  self.body["addr"], "--auth-type=tls", "--token", "test-token"])
        self.assertEqual(kwargs["env"]["LXD_CONF"], self.conf.name)
        self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
        self.assertEqual(kwargs["timeout"], 90)
        self.assertNotIn("--accept-certificate", args[0])

    def test_invalid_inputs_do_not_run_lxc(self):
        for field, values in {
            "name": ["", "--help", "a:b", "a/b", "a\nb", None],
            "addr": ["http://172.16.66.10", "https://", "https://user:pass@host",
                     "https://host/path", "https://host?x=1", "https://host#frag",
                     "https://host:invalid", "https://host:0", None],
            "token": ["", "  ", "two tokens", None],
        }.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    self.assertEqual(self.request({**self.body, field: value})[0], 400)
        self.run.assert_not_called()

    def test_malformed_and_non_object_json(self):
        for raw in ("{", "[]", "null", '"string"', ""):
            with self.subTest(raw=raw):
                self.assertEqual(self.request(raw=raw)[0], 400)
        self.run.assert_not_called()

    def test_oversized_body_is_rejected(self):
        self.assertEqual(self.request(raw="x" * 16385)[0], 400)
        self.run.assert_not_called()

    def test_existing_remote_is_not_overwritten(self):
        self.assertEqual(self.request({**self.body, "name": "local"})[0], 409)
        self.run.assert_not_called()

    def test_cross_origin_and_non_json_requests_are_rejected(self):
        for headers in ({"Origin": "https://other.example"}, {"Sec-Fetch-Site": "cross-site"},
                        {"Host": "other.example"}, {"Content-Type": "text/plain"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request(headers=headers)[0], 403)
        self.run.assert_not_called()

    def test_chunked_request_is_rejected(self):
        self.assertEqual(self.request(headers={"Transfer-Encoding": "chunked"})[0], 411)
        self.assertEqual(self.connection_header, "close")
        self.run.assert_not_called()

    def test_lxc_error_is_reported_without_echoing_token(self):
        self.run.return_value = subprocess.CompletedProcess([], 1, "", "invalid test-token")
        self.assertEqual(self.request(), (502, {"error": "invalid [redacted]"}))

    def test_missing_lxc_is_reported(self):
        self.run.side_effect = FileNotFoundError()
        self.assertEqual(self.request()[0], 503)

    def test_timeout_is_reported_without_echoing_command(self):
        self.run.side_effect = subprocess.TimeoutExpired(["lxc", "test-token"], 90)
        status, body = self.request()
        self.assertEqual(status, 504)
        self.assertNotIn("test-token", body["error"])

    def test_os_error_is_reported(self):
        self.run.side_effect = PermissionError("permission denied")
        status, body = self.request()
        self.assertEqual(status, 502)
        self.assertIn("permission denied", body["error"])


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