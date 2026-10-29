export const VALIDATION_MESSAGES = {
  /** USER VALIDATION MESSAGES */
  EMAIL_INVALID: 'Email must be valid',
  PASSWORD_WEAK:
    'Password must be at least 8 characters long and contain a mix of letters, numbers, and symbols',
  USERNAME_REQUIRED: 'Username is required',
  DATE_OF_BIRTH_INVALID: 'Date of Birth must be a valid ISO date string',
  FIRSTNAME_MAX_LENGTH: 'First name cannot be more than 15 characters.',
  LASTNAME_MAX_LENGTH: 'Last name cannot be more than 15 characters.',
  /**
   * PH7: developer-facing text. Users see the frontend's per-country copy
   * ("Enter a valid Ghana number, like 024 123 4567"), not this (V6).
   */
  PHONE_NUMBER_INVALID:
    'phoneNumber must be a valid phone number for a supported country',
  PHONE_NUMBER_REQUIRED: 'Phone number is required',
  /** PH7: E.164 allows at most 15 digits, plus the leading `+`. */
  PHONE_NUMBER_MAX_LENGTH: 'Phone number cannot be more than 16 characters.',
  /** DI5: `OTHER` stays in the enum for existing rows but is not accepted as input. */
  GENDER_INVALID: 'Gender must be either MALE or FEMALE.',
  GENDER_REQUIRED: 'Gender is required',
  ROLE_INVALID: 'Role must be either CUSTOMER, STYLIST, or ADMIN.',
  PASSWORD_REQUIRED: 'Password is required',
  EMAIL_REQUIRED: 'Email is required',

  /** ADDRESS VALIDATION MESSAGES */
  ADDRESS_LINE1_REQUIRED: 'Address line 1 is required',
  ADDRESS_LINE2_REQUIRED: 'Address line 2 is required',
  STREET_REQUIRED: 'Street is required',
  CITY_REQUIRED: 'City is required',
  STATE_REQUIRED: 'State is required',
  ZIP_CODE_REQUIRED: 'Zip code is required',
  COUNTRY_REQUIRED: 'Country is required',
};
