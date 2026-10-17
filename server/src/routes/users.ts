import Router from 'koa-router';
import { UserController } from '../controllers/UserController';

export const userRoutes = new Router();
const ctrl = new UserController();
userRoutes.get('/', ctrl.list);
userRoutes.post('/', ctrl.create);
userRoutes.patch('/:id', ctrl.update);
userRoutes.delete('/:id', ctrl.remove);
userRoutes.post('/:id/reset-password', ctrl.resetPassword);
userRoutes.post('/:id/revoke-sessions', ctrl.revokeSessions);
