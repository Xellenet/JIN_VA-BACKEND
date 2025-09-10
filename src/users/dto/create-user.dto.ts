import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, MinLength, IsString, IsInt, Min } from 'class-validator';

export class CreateUserDto {
  @ApiProperty({ example: 'john@example.com', description: 'Unique email of the user' })
  @IsEmail({}, { message: 'Email must be valid' })
  email: string;

  @ApiProperty({ example: 'strongPassword123', description: 'User password (min 6 chars)' })
  @IsString()
  @MinLength(6, { message: 'Password must be at least 6 characters' })
  password: string;

  @ApiProperty({ example: 'John Doe', description: 'Full name of the user' })
  @IsString()
  @IsNotEmpty({ message: 'Name is required' })
  name: string;

  @ApiProperty({ example: 25, description: 'Age of the user (must be >= 18)' })
  @IsInt()
  @Min(18, { message: 'Age must be at least 18' })
  age: number;
}
