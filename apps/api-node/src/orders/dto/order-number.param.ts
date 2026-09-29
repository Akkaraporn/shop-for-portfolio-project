import { Matches } from 'class-validator';

/** A path parameter needs a class for the validation pipe to reach it. */
export class OrderNumberParam {
  @Matches(/^ORD-[0-9]{4}-[0-9]{7}$/, {
    message: 'must look like ORD-2026-0000001',
  })
  orderNumber!: string;
}
