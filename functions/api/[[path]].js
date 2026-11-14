// Cloudflare Pages Function：所有 /api/* 請求交給 api/index.js
import { handleApi } from '../../api/index.js';

export const onRequest = ({ request, env }) => handleApi(request, env);
