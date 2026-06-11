"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_js_1 = require("./app.js");
const env_js_1 = require("./config/env.js");
app_js_1.app.listen(env_js_1.env.APP_PORT, () => {
    console.log(`Backend running on http://localhost:${env_js_1.env.APP_PORT}`);
});
