"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.streamGoogleFile = streamGoogleFile;
const google_service_js_1 = require("../google/google.service.js");
const googleDownloadExportMimeTypes = {
    'application/vnd.google-apps.document': { mimeType: 'application/pdf', extension: '.pdf' },
    'application/vnd.google-apps.spreadsheet': { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: '.xlsx' },
    'application/vnd.google-apps.presentation': { mimeType: 'application/pdf', extension: '.pdf' },
    'application/vnd.google-apps.drawing': { mimeType: 'image/png', extension: '.png' },
};
const googlePreviewExportMimeTypes = {
    ...googleDownloadExportMimeTypes,
    'application/vnd.google-apps.spreadsheet': { mimeType: 'application/pdf', extension: '.pdf' },
};
function contentDisposition(type, fileName) {
    return `${type}; filename="${fileName.replaceAll('"', '')}"`;
}
function withExtension(fileName, extension) {
    return fileName.toLowerCase().endsWith(extension) ? fileName : `${fileName}${extension}`;
}
function normalizeHeaders(headers) {
    if (headers instanceof Headers)
        return Object.fromEntries(headers.entries());
    return headers;
}
async function streamGoogleFile(file, range, res, options = {}) {
    const auth = await (0, google_service_js_1.getAuthedGoogleClient)(file.connectedAccount);
    const headers = normalizeHeaders(await auth.getRequestHeaders());
    const exportTarget = (options.disposition === 'inline' ? googlePreviewExportMimeTypes : googleDownloadExportMimeTypes)[file.mimeType];
    const responseMimeType = exportTarget?.mimeType ?? file.mimeType;
    const responseFileName = exportTarget ? withExtension(file.name, exportTarget.extension) : file.name;
    const url = exportTarget
        ? `https://www.googleapis.com/drive/v3/files/${file.providerFileId}/export?mimeType=${encodeURIComponent(exportTarget.mimeType)}`
        : `https://www.googleapis.com/drive/v3/files/${file.providerFileId}?alt=media`;
    const response = await fetch(url, {
        headers: {
            ...headers,
            ...(range && !exportTarget ? { Range: range } : {}),
        },
    });
    if (!response.ok) {
        const message = await response.text().catch(() => response.statusText);
        return res.status(response.status).json({ code: 'GOOGLE_FILE_STREAM_FAILED', message: message || response.statusText });
    }
    res.status(response.status);
    res.setHeader('Content-Type', responseMimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    if (options.disposition)
        res.setHeader('Content-Disposition', contentDisposition(options.disposition, responseFileName));
    const contentLength = response.headers.get('content-length');
    const contentRange = response.headers.get('content-range');
    if (contentLength)
        res.setHeader('Content-Length', contentLength);
    if (contentRange)
        res.setHeader('Content-Range', contentRange);
    if (!response.body) {
        res.end();
        return;
    }
    const reader = response.body.getReader();
    async function pump() {
        const { done, value } = await reader.read();
        if (done) {
            res.end();
            return;
        }
        res.write(Buffer.from(value));
        return pump();
    }
    return pump();
}
