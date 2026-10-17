import Router from 'koa-router';
import { ShareLinkController } from '../controllers/ShareLinkController';

export const shareRoutes = new Router();
const ctrl = new ShareLinkController();

shareRoutes.get('/:token', ctrl.details);
shareRoutes.post('/:token/verification-code', ctrl.verificationCode);
