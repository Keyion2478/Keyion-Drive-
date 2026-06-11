"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptText = encryptText;
exports.decryptText = decryptText;
exports.randomToken = randomToken;
exports.hashToken = hashToken;
const node_crypto_1 = __importDefault(require("node:crypto"));
const env_js_1 = require("../config/env.js");
const key = node_crypto_1.default.createHash('sha256').update(env_js_1.env.TOKEN_ENCRYPTION_KEY).digest();
function encryptText(value) {
    const iv = node_crypto_1.default.randomBytes(12);
    const cipher = node_crypto_1.default.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}
function decryptText(value) {
    const [ivRaw, tagRaw, encryptedRaw] = value.split(':');
    if (!ivRaw || !tagRaw || !encryptedRaw)
        throw new Error('Invalid encrypted payload');
    const decipher = node_crypto_1.default.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64')), decipher.final()]).toString('utf8');
}
function randomToken(bytes = 32) {
    return node_crypto_1.default.randomBytes(bytes).toString('base64url');
}
function hashToken(token) {
    return node_crypto_1.default.createHash('sha256').update(token).digest('hex');
}
