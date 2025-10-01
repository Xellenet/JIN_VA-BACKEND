import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, MinLength, IsString, IsInt, Min, MaxLength, Matches } from 'class-validator';

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
  username: string;

  @ApiProperty({ example: 25, description: 'Age of the user (must be >= 18)' })
  @IsInt()
  age: number;

  @ApiProperty({ example: "John", description: "The first name of the user.",  })
  @IsString()
  @MaxLength(15, { message: 'First name cannot be more than 15 characters.'})
  firstname: string

  @ApiProperty({ example: "Doe", description: "The first name of the user.",  })
  @IsString()
  @MaxLength(15, { message: 'Last name cannot be more than 15 characters.'})
  lastname: string
}
