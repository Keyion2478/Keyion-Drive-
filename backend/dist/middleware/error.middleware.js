"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorMiddleware = errorMiddleware;
function errorMiddleware(error, _req, res, _next) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message });
}
