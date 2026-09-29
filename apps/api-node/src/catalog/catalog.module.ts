import { Module } from '@nestjs/common';

import { CatalogController } from './catalog.controller';
import { CategoriesService } from './categories.service';
import { ProductsService } from './products.service';

@Module({
  controllers: [CatalogController],
  providers: [CategoriesService, ProductsService],
  // CategoriesService is exported so the admin module can invalidate the cached tree,
  // whose product counts change when a product is created, moved or archived.
  exports: [CategoriesService],
})
export class CatalogModule {}
