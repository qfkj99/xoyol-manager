import Router from 'koa-router';
import { AuthController } from '../controllers/AuthController';

export const authRoutes = new Router();
const ctrl = new AuthController();

authRoutes.post('/login', ctrl.login);
authRoutes.post('/register', ctrl.register);
authRoutes.post('/logout', ctrl.logout);
authRoutes.get('/config', ctrl.config);
authRoutes.get('/check', ctrl.config);
authRoutes.get('/me', ctrl.me);
authRoutes.put('/password', ctrl.password);
authRoutes.patch('/profile', ctrl.profile);
