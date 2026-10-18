import Router from 'koa-router';
import { ExternalApiController } from '../controllers/ExternalApiController';

const controller = new ExternalApiController();
export const externalRoutes = new Router();

externalRoutes.get('/accounts', ctx => controller.list(ctx));
externalRoutes.post('/accounts/import', ctx => controller.import(ctx));
externalRoutes.get('/accounts/:id', ctx => controller.details(ctx));
externalRoutes.get('/accounts/:id/share-link', ctx => controller.shareLink(ctx));
externalRoutes.post('/accounts/:id/share-link', ctx => controller.createShareLink(ctx));
externalRoutes.delete('/accounts/:id/share-link', ctx => controller.revokeShareLink(ctx));
externalRoutes.post('/accounts/:id/verification-code', ctx => controller.verificationCode(ctx));
