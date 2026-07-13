import ftplib
import os
import socket
import ssl
import sys


class ReuseImplicitFTP_TLS(ftplib.FTP_TLS):
    def connect(self, host="", port=0, timeout=-999, source_address=None):
        if host:
            self.host = host
        if port:
            self.port = port
        if timeout != -999:
            self.timeout = timeout
        self.sock = socket.create_connection((self.host, self.port), self.timeout, source_address)
        self.af = self.sock.family
        self.sock = self.context.wrap_socket(self.sock, server_hostname=None)
        self.file = self.sock.makefile("r", encoding=self.encoding)
        self.welcome = self.getresp()
        return self.welcome

    def ntransfercmd(self, cmd, rest=None):
        conn, size = ftplib.FTP.ntransfercmd(self, cmd, rest)
        if self._prot_p:
            session = getattr(self.sock, "session", None)
            conn = self.context.wrap_socket(conn, server_hostname=None, session=session)
        return conn, size


def main():
    if len(sys.argv) != 6:
        print("usage: ftps-upload.py <host> <port> <user> <local-path> <remote-path>", file=sys.stderr)
        return 2

    host, port, user, local_path, remote_path = sys.argv[1:]
    password = os.environ.get("BAMBU_ACCESS_CODE", "")
    if not password:
        print("BAMBU_ACCESS_CODE is required", file=sys.stderr)
        return 2

    context = ssl._create_unverified_context()
    ftp = ReuseImplicitFTP_TLS(context=context, timeout=60)
    try:
        ftp.connect(host, int(port))
        ftp.login(user, password)
        ftp.prot_p()
        with open(local_path, "rb") as fh:
            ftp.storbinary(f"STOR {remote_path}", fh)
        ftp.quit()
        print(remote_path)
        return 0
    finally:
        try:
            ftp.close()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
