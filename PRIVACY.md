# Privacy Policy for TeleWire

**Last Updated:** November 2026

TeleWire is committed to protecting your privacy. This Privacy Policy describes how TeleWire handles your data and credentials.

---

## 1. Zero Telemetry & No Analytics

- **No Data Collection:** TeleWire does not collect, log, track, or share any personal information, usage metrics, crash reports, or analytics.
- **No Third-Party Endpoints:** The application does not communicate with any servers, analytics providers, CDNs, or telemetry platforms.
- **Self-Contained Frontend:** The user interface runs strictly in a locked-down desktop webview under a strict Content Security Policy (`default-src 'self'`). All fonts, styles, and assets are bundled locally into the binary.

---

## 2. Direct Peer-to-Telegram Connections

- **No Middleman or Proxy:** TeleWire is a direct MTProto Telegram client. When you browse chats or download files, the network traffic travels directly between Telegram's official data centers and your local computer.
- **No Intermediate Servers:** There are no backend servers, proxy relays, bots, or cloud databases operated by TeleWire.

---

## 3. Storage of Credentials and Account Data

- **API Credentials (`api_id` and `api_hash`):**
  - When provided by the user, your Telegram `api_hash` is securely saved in your operating system's native secure credential vault:
    - **Windows:** Windows Credential Manager
    - **macOS:** Apple Keychain
    - **Linux:** Secret Service / Keyring
  - It is never stored in plain text configuration files or transmitted to any third party.
- **Authentication Sessions:**
  - Your Telegram MTProto session key and authentication state are stored locally on your machine in an encrypted/owner-restricted SQLite session store within your per-user application data directory (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS, `~/.config` on Linux).
  - Session secrets are never exposed to the frontend webview and are never logged.
- **Phone Numbers & Passwords:**
  - Your phone number and two-factor cloud password (if enabled) are sent directly to Telegram's official MTProto servers to authenticate your account. They are never retained in persistent plain-text logs.

---

## 4. Downloaded Content & Local Files

- **Local Storage:** Files downloaded through TeleWire are saved directly to your local file system at your configured download path.
- **No Uploads:** TeleWire never uploads, inspects, indexes, or transmits your downloaded files or messages to any external service.

---

## 5. Security & Open Source Transparency

- TeleWire is free and open-source software under the MIT License.
- You can inspect, audit, and build the source code yourself to verify these privacy guarantees.

---

## 6. Contact

If you have questions regarding this Privacy Policy, please open an issue on the official GitHub repository or contact the maintainers.
