import { IsUUID } from 'class-validator';

/** A path parameter needs a class for the validation pipe to reach it. */
export class ItemIdParam {
  @IsUUID()
  itemId!: string;
}
