# Paper Agent Connector

This unpacked Chromium extension automatically imports PDFs that Edge downloads into the running local Paper Agent.

## Install

1. Keep `.paper-agent/config/app.json` interface port set to `43127`.
2. Start Paper Agent.
3. Open `chrome://extensions` or `edge://extensions`.
4. Enable developer mode, choose **Load unpacked**, and select this `browser-extension` directory.

The extension listens to Edge's completed downloads and accepts PDF MIME types, PDF filenames, and explicit PDF URL paths such as ACM's `/doi/pdf/` routes. It imports through the local Connector only while Paper Agent is running, always targeting the current default personal namespace. Downloads made while Paper Agent is stopped are ignored instead of queued for a later import.

Use Edge's PDF download button or `Ctrl+S`. The extension imports the browser-saved file after the download completes; it does not re-request the PDF URL. After Paper Agent confirms that the personal-library copy was saved, the extension removes the original file from the browser download directory. Failed imports leave the original file untouched; Edge download history remains intact.

This avoids failures from short-lived publisher URLs, anti-crawling protections, and institution-authenticated pages when Edge has already saved the PDF successfully.
