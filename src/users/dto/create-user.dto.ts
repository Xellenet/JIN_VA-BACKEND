import { Gender, Role } from '@common/types/enums';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsNotEmpty, MinLength, IsString, MaxLength, Matches, IsEnum, ArrayMinSize, IsArray, IsOptional, ValidateNested, IsDateString } from 'class-validator';
import { CreateAddressDto } from './create-address.dto';
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';
import { VARIABLES } from '@common/constants/variables.constants';

export class CreateUserDto {
  @ApiProperty({ example: 'john@example.com', description: 'Unique email of the user' })
  @IsEmail({}, { message: VALIDATION_MESSAGES.EMAIL_INVALID })
  email: string;

  @ApiProperty({
  example: 'Strong@123',
  description: VALIDATION_MESSAGES.PASSWORD_WEAK,
})
  @IsString()
  @Matches(VARIABLES.PASSWORD_REGEX, {
  message:
    VALIDATION_MESSAGES.PASSWORD_WEAK,
  })
  @MinLength(8)
  password: string;

  @ApiProperty({ example: 'johndoe', description: 'Full name of the user' })
  @IsString()
  @IsNotEmpty({ message: VALIDATION_MESSAGES.USERNAME_REQUIRED })
  username?: string;

  @ApiProperty({
    example: '2025-10-25',
    description: 'Date of Birth of the User',
    required: false,
  })
  @IsOptional()
  @IsDateString({}, { message: VALIDATION_MESSAGES.DATE_OF_BIRTH_INVALID })
  dateOfBirth?: string;

  @ApiProperty({ example: "John", description: "The first name of the user.",  })
  @IsString()
  @MaxLength(15, { message: VALIDATION_MESSAGES.FIRSTNAME_MAX_LENGTH })
  firstname: string

  @ApiProperty({ example: "Doe", description: "The last name of the user.",  })
  @IsString()
  @MaxLength(15, { message: VALIDATION_MESSAGES.LASTNAME_MAX_LENGTH })
  lastname: string

  @ApiProperty({example: '123-456-7890', description: 'Phone number of the user'})
  @IsString()
  @IsOptional()
  @MaxLength(12, { message: VALIDATION_MESSAGES.PHONE_NUMBER_MAX_LENGTH })
  @Matches(VARIABLES.PHONENUMBER_REGEX, { message: VALIDATION_MESSAGES.PHONE_NUMBER_INVALID })
  phoneNumber?: string;

  @ApiProperty({ example: "male", description: "The gender of the user." })
  @IsEnum(Gender, { message: VALIDATION_MESSAGES.GENDER_INVALID })
  gender: Gender;

  @ApiProperty({ example: "customer", description: "The role of the user." })
  @IsEnum(Role, { message: VALIDATION_MESSAGES.ROLE_INVALID })
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
