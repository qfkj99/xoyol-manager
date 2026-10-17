import { Context } from 'koa';
import { DashboardService } from '../services/DashboardService';
import { success } from '../utils/response';
import { getUser } from '../middlewares/auth';

const dashboardService = new DashboardService();

export class DashboardController {
  async stats(ctx: Context) {
    const data = dashboardService.getStats(getUser(ctx), ctx.query.owner_user_id);
    success(ctx, data);
  }
}
