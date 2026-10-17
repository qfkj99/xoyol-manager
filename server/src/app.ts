import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import serve from 'koa-static';
import path from 'path';
import fs from 'fs';
import { loggerMiddleware } from './middlewares/logger';
import { errorHandler } from './middlewares/errorHandler';
import { authMiddleware } from './middlewares/auth';
import { maintenanceMiddleware } from './middlewares/maintenance';
import router from './routes';

const app = new Koa();
app.proxy = process.env.TRUST_PROXY === 'true';

// 中间件
app.use(errorHandler);
app.use(async (ctx, next) => {
  if (/^\/(?:s|api\/share)(?:\/|$)/.test(ctx.path) || /^\/api\/accounts\/[^/]+\/share-link\/?$/.test(ctx.path)) {
    ctx.set('Cache-Control', 'no-store');
    ctx.set('Referrer-Policy', 'no-referrer');
    ctx.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    ctx.set('X-Content-Type-Options', 'nosniff');
  }
  await next();
});
app.use(loggerMiddleware);
app.use(maintenanceMiddleware);
const regularBody = bodyParser({ jsonLimit: '10mb' });
const restoreBody = bodyParser({ jsonLimit: '72mb' });
app.use((ctx, next) => ctx.path === '/api/backup/restore' ? restoreBody(ctx, next) : regularBody(ctx, next));
app.use(authMiddleware);
app.use(async (ctx, next) => {
  if (ctx.path.startsWith('/api')) ctx.set('Cache-Control', 'no-store');
  ctx.set('X-Content-Type-Options', 'nosniff');
  if (!ctx.response.get('Referrer-Policy')) ctx.set('Referrer-Policy', 'same-origin');
  await next();
});

// API 路由
app.use(router.routes());
app.use(router.allowedMethods());

// 前端静态资源
const distPath = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(distPath)) {
  app.use(serve(distPath, { maxage: 365 * 24 * 60 * 60 * 1000, gzip: true }));

  // SPA fallback
  app.use(async (ctx) => {
    if (!ctx.path.startsWith('/api') && !ctx.path.includes('.')) {
      const indexPath = path.join(distPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        ctx.type = 'html';
        ctx.body = fs.createReadStream(indexPath);
      }
    }
  });
}

export default app;
