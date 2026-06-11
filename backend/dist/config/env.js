"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const zod_1 = require("zod");
dotenv_1.default.config();
const envSchema = zod_1.z.object({
    DATABASE_URL: zod_1.z.string().min(1),
    APP_PORT: zod_1.z.coerce.number().default(4000),
    FRONTEND_URL: zod_1.z.string().url(),
    JWT_ACCESS_SECRET: zod_1.z.string().min(32),
    TOKEN_ENCRYPTION_KEY: zod_1.z.string().min(32),
    ACCESS_TOKEN_TTL_SECONDS: zod_1.z.coerce.number().default(900),
    REFRESH_TOKEN_TTL_DAYS: zod_1.z.coerce.number().default(30),
    MAX_UPLOAD_BYTES: zod_1.z.coerce.number().default(5 * 1024 * 1024 * 1024),
    RECAPTCHA_SECRET_KEY: zod_1.z.string().optional(),
});
exports.env = envSchema.parse(process.env);
