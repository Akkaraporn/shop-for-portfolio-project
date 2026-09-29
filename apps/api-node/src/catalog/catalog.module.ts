import { Module } from '@nestjs/common';

import { CatalogController } from './catalog.controller';
import { CategoriesService } from './categories.service';
import { ProductsService } from './products.service';

@Module({
  controllers: [CatalogController],
  providers: [CategoriesService, ProductsService],
  // CategoriesService is exported so the admin module (task 2.7) can invalidate the
  // cached tree when a category changes.
  exports: [CategoriesService],
})
export class CatalogModule {}
