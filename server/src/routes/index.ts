import Router from 'koa-router';
import db from '../database';
import { success } from '../utils/response';
import { accountRoutes } from './accounts';
import { mailRoutes } from './mails';
import { proxyRoutes } from './proxies';
import { dashboardRoutes } from './dashboard';
import { authRoutes } from './auth';
import { tagRoutes } from './tags';
import { backupRoutes } from './backup';
import { userRoutes } from './users';
import { settingsRoutes } from './settings';
import { auditRoutes } from './audit';
import { shareRoutes } from './share';
import { apiKeyRoutes } from './apiKeys';
import { externalRoutes } from './external';

const router = new Router({ prefix: '/api' });

// A container probe must work over loopback HTTP without creating secure cookies.
router.get('/health', ctx => {
  db.prepare('SELECT 1').get();
  success(ctx, { status: 'ok' });
});

router.use('/accounts', accountRoutes.routes(), accountRoutes.allowedMethods());
router.use('/mails', mailRoutes.routes(), mailRoutes.allowedMethods());
router.use('/proxies', proxyRoutes.routes(), proxyRoutes.allowedMethods());
router.use('/dashboard', dashboardRoutes.routes(), dashboardRoutes.allowedMethods());
router.use('/auth', authRoutes.routes(), authRoutes.allowedMethods());
router.use('/tags', tagRoutes.routes(), tagRoutes.allowedMethods());
router.use('/backup', backupRoutes.routes(), backupRoutes.allowedMethods());
router.use('/users', userRoutes.routes(), userRoutes.allowedMethods());
router.use('/settings', settingsRoutes.routes(), settingsRoutes.allowedMethods());
router.use('/audit', auditRoutes.routes(), auditRoutes.allowedMethods());
router.use('/share', shareRoutes.routes(), shareRoutes.allowedMethods());
router.use('/api-keys', apiKeyRoutes.routes(), apiKeyRoutes.allowedMethods());
router.use('/external/v1', externalRoutes.routes(), externalRoutes.allowedMethods());

export default router;
