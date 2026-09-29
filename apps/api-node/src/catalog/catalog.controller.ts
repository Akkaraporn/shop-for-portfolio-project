import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { Matches } from 'class-validator';

import { Public } from '../auth/decorators/public.decorator';
import type { Page } from '../common/pagination/cursor';
import { CategoriesService } from './categories.service';
import { CATEGORY_TREE_TTL_SECONDS } from './categories.service';
import type { CategoryNode, ProductDetail, ProductSummary } from './catalog.types';
import { ListProductsQuery } from './dto/list-products.query';
import { ProductsService } from './products.service';

/** A path parameter needs a class for the validation pipe to reach it. */
class SlugParam {
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'must be a lowercase hyphenated slug',
  })
  slug!: string;
}

/**
 * The public catalogue. Everything here is unauthenticated: browsing is what a
 * shop does before anyone signs in.
 */
@Controller()
@Public()
export class CatalogController {
  constructor(
    private readonly categories: CategoriesService,
    private readonly products: ProductsService,
  ) {}

  /**
   * The category tree.
   *
   * `Cache-Control` lets a browser and any intermediary cache reuse this for the
   * same five minutes Redis does, which matters because the tree is fetched by
   * every page of the site.
   */
  @Get('categories')
  @Header('Cache-Control', `public, max-age=${CATEGORY_TREE_TTL_SECONDS}`)
  listCategories(): Promise<Page<CategoryNode>> {
    return this.categories.tree();
  }

  @Get('products')
  listProducts(@Query() query: ListProductsQuery): Promise<Page<ProductSummary>> {
    return this.products.list(query);
  }

  @Get('products/:slug')
  getProduct(@Param() params: SlugParam): Promise<ProductDetail> {
    return this.products.findBySlug(params.slug);
  }
}
