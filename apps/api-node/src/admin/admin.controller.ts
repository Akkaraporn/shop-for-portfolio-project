import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { Page } from '../common/pagination/cursor';
import { OrderNumberParam } from '../orders/dto/order-number.param';
import type { OrderView } from '../orders/order.types';
import {
  AdminService,
  type AdminProductView,
  type AdminVariantView,
} from './admin.service';
import {
  CreateProductDto,
  ListAdminOrdersQuery,
  ListAdminProductsQuery,
  ProductIdParam,
  StockAdjustmentDto,
  UpdateOrderStatusDto,
  UpdateProductDto,
  VariantIdParam,
} from './dto/admin.dto';

/**
 * The back office. `@Roles('admin')` on the class covers every route, so an endpoint
 * added here later cannot forget it: a customer token gets 403, no token 401.
 */
@Controller('admin')
@Roles('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('products')
  listProducts(
    @Query() query: ListAdminProductsQuery,
  ): Promise<Page<AdminProductView>> {
    return this.admin.listProducts(query);
  }

  @Post('products')
  createProduct(@Body() body: CreateProductDto): Promise<AdminProductView> {
    return this.admin.createProduct(body);
  }

  @Patch('products/:productId')
  updateProduct(
    @Param() params: ProductIdParam,
    @Body() body: UpdateProductDto,
  ): Promise<AdminProductView> {
    return this.admin.updateProduct(params.productId, body);
  }

  @Patch('variants/:variantId/stock')
  adjustStock(
    @Param() params: VariantIdParam,
    @Body() body: StockAdjustmentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AdminVariantView> {
    return this.admin.adjustStock(params.variantId, body, user.id);
  }

  @Get('orders')
  listOrders(
    @Query() query: ListAdminOrdersQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<OrderView>> {
    return this.admin.listOrders(query, user.id);
  }

  @Patch('orders/:orderNumber/status')
  @HttpCode(HttpStatus.OK)
  updateOrderStatus(
    @Param() params: OrderNumberParam,
    @Body() body: UpdateOrderStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderView> {
    return this.admin.updateOrderStatus(
      params.orderNumber,
      body.status,
      user.id,
    );
  }
}
