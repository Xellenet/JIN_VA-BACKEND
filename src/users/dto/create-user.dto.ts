import { Gender, Role } from '@common/types/enums';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsNotEmpty, MinLength, IsString, MaxLength, Matches, IsEnum, ArrayMinSize, IsArray, IsOptional, ValidateNested, IsDateString } from 'class-validator';
import { CreateAddressDto } from './create-address.dto';

export class CreateUserDto {
  @ApiProperty({ example: 'john@example.com', description: 'Unique email of the user' })
  @IsEmail({}, { message: 'Email must be valid' })
  email: string;

  @ApiProperty({
  example: 'Strong@123',
  description: 'User password (min 8 chars, must include uppercase, lowercase, number, and special character)',
})
  @IsString()
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*])[A-Za-z\d!@#$%^&*]{8,128}$/, {
  message:
    'Password must be 8-128 characters long and include at least one uppercase letter, one lowercase letter, one number, and one special character (!@#$%^&*)',
  })
  @MinLength(8)
  password: string;

  @ApiProperty({ example: 'johndoe', description: 'Full name of the user' })
  @IsString()
  @IsNotEmpty({ message: 'username is required' })
  username?: string;

  @ApiProperty({
    example: '2025-10-25',
    description: 'Date of Birth of the User',
    required: false, // optional in Swagger
  })
  @IsOptional()
  @IsDateString({}, { message: 'dateOfBirth must be a valid ISO date string' })
  dateOfBirth?: string;

  @ApiProperty({ example: "John", description: "The first name of the user.",  })
  @IsString()
  @MaxLength(15, { message: 'First name cannot be more than 15 characters.'})
  firstname: string

  @ApiProperty({ example: "Doe", description: "The first name of the user.",  })
  @IsString()
  @MaxLength(15, { message: 'Last name cannot be more than 15 characters.'})
  lastname: string

  @ApiProperty({example: '123-456-7890', description: 'Phone number of the user'})
  @IsString()
  @IsOptional()
  @MaxLength(12, { message: 'Phone number cannot be more than 12 characters.'})
  @Matches(/^\d{3}-\d{3}-\d{4}$/, { message: 'Phone number must be in the format XXX-XXX-XXXX' })
  phoneNumber?: string;

  @ApiProperty({ example: "male", description: "The gender of the user." })
  @IsEnum(Gender, { message: 'Gender must be either male, female, or other.' })
  gender: Gender;

  @ApiProperty({ example: "customer", description: "The role of the user." })
  @IsEnum(Role, { message: 'Role must be either customer, stylist, or admin.' })
  role: Role;

    @ApiProperty({
    type: [CreateAddressDto],
    description: 'List of addresses for the user',
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => CreateAddressDto)
  addresses?: CreateAddressDto[];

}
