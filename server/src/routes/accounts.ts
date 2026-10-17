import Router from 'koa-router';
import { AccountController } from '../controllers/AccountController';
import { ShareLinkController } from '../controllers/ShareLinkController';

export const accountRoutes = new Router();
const ctrl = new AccountController();
const shares = new ShareLinkController();

accountRoutes.get('/', ctrl.list);
accountRoutes.get('/:id/credentials', ctrl.credentials);
accountRoutes.get('/:id/share-link', shares.get);
accountRoutes.post('/:id/share-link', shares.create);
accountRoutes.delete('/:id/share-link', shares.revoke);
accountRoutes.post('/claim', ctrl.claim);
accountRoutes.post('/claim-pool', ctrl.publishClaims);
accountRoutes.post('/claim-pool/revoke', ctrl.revokeClaims);
accountRoutes.post('/transfer', ctrl.transfer);
accountRoutes.post('/transfer-resources', ctrl.transferResources);
accountRoutes.post('/', ctrl.create);
accountRoutes.put('/:id', ctrl.update);
accountRoutes.delete('/:id', ctrl.delete);
accountRoutes.post('/batch-delete', ctrl.batchDelete);
accountRoutes.post('/import', ctrl.import);
accountRoutes.post('/import-preview', ctrl.importPreview);
accountRoutes.post('/import-confirm', ctrl.importConfirm);
accountRoutes.post('/export', ctrl.export);
accountRoutes.post('/:id/tags', ctrl.setTags);
