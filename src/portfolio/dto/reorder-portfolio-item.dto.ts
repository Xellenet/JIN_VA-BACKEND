import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class ReorderPortfolioItemDto {
  @ApiProperty({
    example: 2,
    description: "New position for this item within the artisan's gallery.",
  })
  @IsInt()
  @Min(0)
  sortOrder!: number;
}
