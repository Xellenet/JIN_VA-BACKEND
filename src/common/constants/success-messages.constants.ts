/**
 * Centralised success message strings for all service responses.
 * Import this constant in service methods that return a `{ message, data }` payload
 * so the response interceptor can surface a meaningful message to the client.
 */
export const SUCCESS_MESSAGES = {
  USER: {
    CREATED: 'User created successfully',
    RETRIEVED: 'User profile retrieved successfully',
    UPDATED: 'User profile updated successfully',
    DELETED: 'Account deleted successfully.',
    AVATAR_UPLOADED: 'Profile picture updated successfully.',
  },
  ARTISAN_PROFILE: {
    RETRIEVED: 'Artisan profile retrieved successfully',
    ALL_RETRIEVED: 'Artisans retrieved successfully',
    UPDATED: 'Artisan profile updated successfully',
    SERVICE_ADDED: 'Service added to your profile successfully.',
    SERVICE_REMOVED: 'Service removed from your profile successfully.',
  },
  CUSTOMER_PROFILE: {
    RETRIEVED: 'Customer profile retrieved successfully',
    UPDATED: 'Customer profile updated successfully',
  },
  SERVICE: {
    CREATED: 'Service created successfully',
    RETRIEVED: 'Service retrieved successfully',
    ALL_RETRIEVED: 'Services retrieved successfully',
    UPDATED: 'Service updated successfully',
    DELETED: 'Service deleted successfully',
  },
  REVIEW: {
    CREATED: 'Review submitted successfully',
    RETRIEVED: 'Review retrieved successfully',
    ALL_RETRIEVED: 'Reviews retrieved successfully',
  },
  JOB: {
    CREATED: 'Job created successfully',
    RETRIEVED: 'Job retrieved successfully',
    ALL_RETRIEVED: 'Jobs retrieved successfully',
    UPDATED: 'Job updated successfully',
    DELETED: 'Job deleted successfully',
    APPLICATION_SUBMITTED: 'Application submitted successfully.',
    APPLICATIONS_RETRIEVED: 'Applications retrieved successfully.',
    APPLICATION_ACCEPTED: 'Application accepted. Job is now pending artisan start.',
    STARTED: 'Job started. Work is now in progress.',
    COMPLETION_REQUESTED: 'Completion request submitted. Awaiting customer confirmation.',
    CONFIRMED: 'Job confirmed as complete. Payment has been released.',
    CANCELLED: 'Job cancelled successfully.',
  },
  FAVOURITE: {
    ADDED: 'Artisan added to favourites.',
    REMOVED: 'Artisan removed from favourites.',
    ALL_RETRIEVED: 'Favourites retrieved successfully.',
  },
  MESSAGE: {
    SENT: 'Message sent.',
    CONVERSATIONS_RETRIEVED: 'Conversations retrieved.',
    THREAD_RETRIEVED: 'Messages retrieved.',
    MARKED_READ: 'Messages marked as read.',
  },
  NOTIFICATION: {
    ALL_RETRIEVED: 'Notifications retrieved.',
    MARKED_READ: 'Notification marked as read.',
    ALL_MARKED_READ: 'All notifications marked as read.',
  },
  AUTH: {
    USER_REGISTERED: 'User registered successfully',
    USER_LOGGED_IN: 'User logged in successfully',
    EMAIL_VERIFIED: 'Email verified successfully',
    PASSWORD_RESET_EMAIL_SENT: 'Password reset link sent to your email',
    PASSWORD_RESET_SUCCESS: 'Password reset successfully',
    TOKENS_REFRESHED: 'Tokens refreshed successfully',
    PASSWORD_CHANGED: 'Password changed successfully',
  },
};
