export const VALIDATION_MESSAGES = {
    /** USER VALIDATION MESSAGES */
    EMAIL_INVALID: 'Email must be valid',
    PASSWORD_WEAK: 'Password must be at least 8 characters long and contain a mix of letters, numbers, and symbols', 
    USERNAME_REQUIRED: 'Username is required',
    DATE_OF_BIRTH_INVALID: 'Date of Birth must be a valid ISO date string',
    FIRSTNAME_MAX_LENGTH: 'First name cannot be more than 15 characters.',
    LASTNAME_MAX_LENGTH: 'Last name cannot be more than 15 characters.',
    PHONE_NUMBER_INVALID: 'Phone number must be in the format XXX-XXX-XXXX',
    PHONE_NUMBER_MAX_LENGTH: 'Phone number cannot be more than 12 characters.',
    GENDER_INVALID: 'Gender must be either MALE, FEMALE, or OTHER.',
    ROLE_INVALID: 'Role must be either CUSTOMER, STYLIST, or ADMIN.',

    /** ADDRESS VALIDATION MESSAGES */
    ADDRESS_LINE1_REQUIRED: 'Address line 1 is required',
    ADDRESS_LINE2_REQUIRED: 'Address line 2 is required',
    STREET_REQUIRED: 'Street is required',
    CITY_REQUIRED: 'City is required',
    STATE_REQUIRED: 'State is required',
    ZIP_CODE_REQUIRED: 'Zip code is required',
    COUNTRY_REQUIRED: 'Country is required',
}