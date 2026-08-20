/**
 * FICHIER GÉNÉRÉ — NE PAS ÉDITER À LA MAIN.
 * Types dérivés du contrat OpenAPI du PMS (Stay-api).
 * Régénérer : `yarn gen:types` (voir README + openapi-ts.config.ts).
 * Source : openapi/stay-api.json — snapshot de GET /swagger/v1/swagger.json (Swagger dev-only).
 */

export interface paths {
    "/api/v1/AdminAnalytics/dashboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Admin Dashboard
         * @description Gets platform-wide dashboard analytics. Admin only.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AdminDashboardDto"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Forbidden - Admin role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/AdminAnalytics/subscriptions/monthly": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Monthly Subscriptions
         * @description Gets monthly subscription statistics including new, cancelled, and active subscriptions. Admin only.
         */
        get: {
            parameters: {
                query?: {
                    /** @description The year to get analytics for (defaults to current year). */
                    year?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["MonthlySubscriptionsDto"][];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Forbidden - Admin role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/AdminAnalytics/subscriptions/distribution": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Subscription Distribution
         * @description Gets distribution of hotels across subscription plans. Admin only.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SubscriptionPlanDistributionDto"][];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Forbidden - Admin role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/AdminAnalytics/revenue/by-region": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Revenue By Region
         * @description Gets revenue breakdown by country/region. Admin only.
         */
        get: {
            parameters: {
                query?: {
                    /** @description Optional start date filter. */
                    startDate?: string;
                    /** @description Optional end date filter. */
                    endDate?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RevenueByRegionDto"][];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Forbidden - Admin role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/hotels": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search and filter hotels with manager and subscription details (Admin only). */
        get: {
            parameters: {
                query?: {
                    Search?: string;
                    City?: string;
                    Country?: string;
                    Category?: string;
                    ManagerId?: string;
                    SubscriptionId?: string;
                    HasActiveSubscription?: boolean;
                    IncludeDeleted?: boolean;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AdminHotelDtoApiListResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/hotels/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a single hotel with full admin details (Admin only). */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AdminHotelDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AdminHotelDtoApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get current platform settings (Admin only). */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AdminSettingsDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        /**
         * Update platform settings (Admin only).
         *     Only provided (non-null) values will be updated.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The settings to update. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["UpdateAdminSettingsDto"];
                    "text/json": components["schemas"]["UpdateAdminSettingsDto"];
                    "application/*+json": components["schemas"]["UpdateAdminSettingsDto"];
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AdminSettingsDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/settings/reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reset platform settings to defaults (Admin only). */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AdminSettingsDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Login
         * @description Authenticates a user with email and password.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The login request containing email and password. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["LoginRequestDto"];
                    "text/json": components["schemas"]["LoginRequestDto"];
                    "application/*+json": components["schemas"]["LoginRequestDto"];
                };
            };
            responses: {
                /** @description Login successful */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AuthResponseDtoApiResponse"];
                    };
                };
                /** @description Invalid credentials */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AuthResponseDtoApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/register/customer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register Customer
         * @description Creates a new customer account.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The customer registration request. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["RegisterCustomerRequestDto"];
                    "text/json": components["schemas"]["RegisterCustomerRequestDto"];
                    "application/*+json": components["schemas"]["RegisterCustomerRequestDto"];
                };
            };
            responses: {
                /** @description Registration successful */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AuthResponseDtoApiResponse"];
                    };
                };
                /** @description Validation error or email already exists */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AuthResponseDtoApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/register/manager": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register Manager
         * @description Creates a new hotel manager account.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The manager registration request. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["RegisterManagerRequestDto"];
                    "text/json": components["schemas"]["RegisterManagerRequestDto"];
                    "application/*+json": components["schemas"]["RegisterManagerRequestDto"];
                };
            };
            responses: {
                /** @description Registration successful */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AuthResponseDtoApiResponse"];
                    };
                };
                /** @description Validation error or email already exists */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AuthResponseDtoApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/register/receptionist": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register Receptionist
         * @description Manager creates a receptionist for their hotel.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The receptionist registration request. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["RegisterReceptionistRequestDto"];
                    "text/json": components["schemas"]["RegisterReceptionistRequestDto"];
                    "application/*+json": components["schemas"]["RegisterReceptionistRequestDto"];
                };
            };
            responses: {
                /** @description Registration successful */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AuthResponseDtoApiResponse"];
                    };
                };
                /** @description Validation error or email already exists */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AuthResponseDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Manager role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/refresh-token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Refresh Token
         * @description Gets new tokens using a refresh token.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The refresh token request. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["RefreshTokenRequestDto"];
                    "text/json": components["schemas"]["RefreshTokenRequestDto"];
                    "application/*+json": components["schemas"]["RefreshTokenRequestDto"];
                };
            };
            responses: {
                /** @description Token refreshed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AuthResponseDtoApiResponse"];
                    };
                };
                /** @description Invalid or expired refresh token */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AuthResponseDtoApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/forgot-password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Forgot Password
         * @description Sends password reset email.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The forgot password request. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["ForgotPasswordRequestDto"];
                    "text/json": components["schemas"]["ForgotPasswordRequestDto"];
                    "application/*+json": components["schemas"]["ForgotPasswordRequestDto"];
                };
            };
            responses: {
                /** @description Reset email sent if account exists */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/reset-password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Reset Password
         * @description Resets password with token.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The reset password request. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["ResetPasswordRequestDto"];
                    "text/json": components["schemas"]["ResetPasswordRequestDto"];
                    "application/*+json": components["schemas"]["ResetPasswordRequestDto"];
                };
            };
            responses: {
                /** @description Password reset successful */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Invalid or expired token */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/change-password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Change Password
         * @description Changes password for authenticated user.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The change password request. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["ChangePasswordRequestDto"];
                    "text/json": components["schemas"]["ChangePasswordRequestDto"];
                    "application/*+json": components["schemas"]["ChangePasswordRequestDto"];
                };
            };
            responses: {
                /** @description Password changed successfully */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Current password incorrect or validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Logout
         * @description Revokes all refresh tokens for current user.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Logged out successfully */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Current User
         * @description Returns current user's profile.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CurrentUserDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/hotels/{hotelId}/communications/branding": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Gets the branding (logo + primary color) for a hotel. Returns defaults when none is set. */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BrandingDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BrandingDtoApiResponse"];
                    };
                };
            };
        };
        /** Creates or updates the branding (logo + primary color) for a hotel. */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            /** @description The branding update payload (only non-null fields are applied). */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["UpdateBrandingDto"];
                    "text/json": components["schemas"]["UpdateBrandingDto"];
                    "application/*+json": components["schemas"]["UpdateBrandingDto"];
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BrandingDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BrandingDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["BrandingDtoApiResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/hotels/{hotelId}/communications/email-templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Gets the email templates for a hotel: one resolved template (custom or default) per
         *     supported Event × Language, plus the allowed variable catalog and editor metadata.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["EmailTemplatesResponseDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        /** Creates or updates one email template for a hotel, keyed by (Event, Language). */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            /** @description The email template update payload. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["UpdateEmailTemplateDto"];
                    "text/json": components["schemas"]["UpdateEmailTemplateDto"];
                    "application/*+json": components["schemas"]["UpdateEmailTemplateDto"];
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["EmailTemplateDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["EmailTemplateDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/hotels/{hotelId}/communications/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Renders an email preview (subject + body) for a hotel using sample data and the hotel branding.
         *     The content to preview is supplied in the request (current editor state, possibly unsaved).
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            /** @description The preview request (event, language, subject, body). */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["EmailPreviewRequestDto"];
                    "text/json": components["schemas"]["EmailPreviewRequestDto"];
                    "application/*+json": components["schemas"]["EmailPreviewRequestDto"];
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["EmailPreviewResultDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["EmailPreviewResultDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/hotels/{hotelId}/communications/pdf-templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Gets the confirmation-PDF templates for a hotel: one resolved template (custom or default)
         *     per supported language, plus the resolved branding (logo + primary color) applied to the PDF.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PdfTemplatesResponseDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        /** Creates or updates one confirmation-PDF template for a hotel, keyed by Language. */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            /** @description The PDF template update payload. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["UpdatePdfTemplateDto"];
                    "text/json": components["schemas"]["UpdatePdfTemplateDto"];
                    "application/*+json": components["schemas"]["UpdatePdfTemplateDto"];
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PdfTemplateDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PdfTemplateDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/hotels/{hotelId}/communications/pdf-preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Renders a confirmation-PDF preview (branding + contextual mentions + example summary + QR) for
         *     a hotel, using the current editor content. The PDF is returned as base64 and never persisted.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            /** @description The PDF preview request (language + contextual mentions). */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["PdfPreviewRequestDto"];
                    "text/json": components["schemas"]["PdfPreviewRequestDto"];
                    "application/*+json": components["schemas"]["PdfPreviewRequestDto"];
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PdfPreviewResultDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PdfPreviewResultDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/hotels/{hotelId}/communications/send-logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Lists the hotel's email send-log entries (most recent first), optionally filtered by outcome
         *     (e.g. only failures) and date range. Metadata only — never the recipient address or the email
         *     body (RGPD). Strictly scoped to the owning Manager's hotel (Story 7.4, FR-8).
         */
        get: {
            parameters: {
                query?: {
                    Status?: components["schemas"]["EmailOutboxStatus"];
                    StartDate?: string;
                    EndDate?: string;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["EmailSendLogDtoApiListResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Files/{filePath}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Gets a file by its path. */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The relative file path. */
                    filePath: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** Deletes a file by its path (for files without database records like profile pictures, hotel logos, documents). */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The relative file path to delete. */
                    filePath: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Files/profile-picture": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Uploads a profile picture for the current user. */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "multipart/form-data": {
                        /**
                         * Format: binary
                         * @description The image file to upload.
                         */
                        file?: string;
                    };
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FileResultDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FileResultDtoApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Files/receptionists/{receptionistId}/profile-picture": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Uploads a profile picture for a receptionist (manager of their hotel only). */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The receptionist user identifier. */
                    receptionistId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "multipart/form-data": {
                        /**
                         * Format: binary
                         * @description The image file.
                         */
                        file?: string;
                    };
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FileResultDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FileResultDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProblemDetails"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProblemDetails"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Files/hotels/{hotelId}/logo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Uploads a logo for a hotel. */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "multipart/form-data": {
                        /**
                         * Format: binary
                         * @description The logo file to upload.
                         */
                        file?: string;
                    };
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FileResultDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FileResultDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProblemDetails"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ProblemDetails"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FileResultDtoApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Files/rooms/{roomId}/images": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Gets all images for a room. */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The room identifier. */
                    roomId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomImageDtoIReadOnlyListApiResponse"];
                    };
                };
            };
        };
        put?: never;
        /** Uploads an image for a room. */
        post: {
            parameters: {
                query?: {
                    /** @description Whether to set as primary image. */
                    isPrimary?: boolean;
                };
                header?: never;
                path: {
                    /** @description The room identifier. */
                    roomId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "multipart/form-data": {
                        /**
                         * Format: binary
                         * @description The image file to upload.
                         */
                        file?: string;
                    };
                };
            };
            responses: {
                /** @description Created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomImageDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomImageDtoApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Files/rooms/images/{imageId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Deletes a room image. */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The image identifier. */
                    imageId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Files/rooms/images/{imageId}/primary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Sets a room image as primary. */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The image identifier. */
                    imageId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Files/rooms/{roomId}/images/reorder": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Reorders room images. */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The room identifier. */
                    roomId: string;
                };
                cookie?: never;
            };
            /** @description The reorder request containing image IDs. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["ReorderImagesRequest"];
                    "text/json": components["schemas"]["ReorderImagesRequest"];
                    "application/*+json": components["schemas"]["ReorderImagesRequest"];
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Files/documents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Uploads a document. */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "multipart/form-data": {
                        /**
                         * Format: binary
                         * @description The document file to upload.
                         */
                        file?: string;
                    };
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FileResultDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["FileResultDtoApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/HotelAnalytics/hotels/{hotelId}/dashboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Hotel Dashboard
         * @description Gets dashboard analytics for a hotel including occupancy, revenue, and reservations. Manager only.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel ID. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelDashboardDto"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Forbidden - Not the hotel manager */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Hotel not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/HotelAnalytics/hotels/{hotelId}/revenue/monthly": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Monthly Revenue
         * @description Gets monthly revenue breakdown for a hotel. Manager only.
         */
        get: {
            parameters: {
                query?: {
                    /** @description The year to get analytics for (defaults to current year). */
                    year?: number;
                };
                header?: never;
                path: {
                    /** @description The hotel ID. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["MonthlyRevenueDto"][];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Forbidden - Not the hotel manager */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Hotel not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/HotelAnalytics/hotels/{hotelId}/payments/by-service": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Payments By Service
         * @description Gets payment count and revenue grouped by service. Manager only.
         */
        get: {
            parameters: {
                query?: {
                    /** @description Optional start date filter. */
                    startDate?: string;
                    /** @description Optional end date filter. */
                    endDate?: string;
                };
                header?: never;
                path: {
                    /** @description The hotel ID. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PaymentsByServiceDto"][];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Forbidden - Not the hotel manager */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Hotel not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/HotelAnalytics/hotels/{hotelId}/reservations/monthly": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Monthly Reservations
         * @description Gets monthly reservation statistics including confirmed, cancelled, and occupancy rate. Manager only.
         */
        get: {
            parameters: {
                query?: {
                    /** @description The year to get analytics for (defaults to current year). */
                    year?: number;
                };
                header?: never;
                path: {
                    /** @description The hotel ID. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["MonthlyRoomReservationsDto"][];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Forbidden - Not the hotel manager */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Hotel not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Hotels/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search hotels with filters and pagination (public endpoint for customers). */
        get: {
            parameters: {
                query?: {
                    Search?: string;
                    City?: string;
                    Country?: string;
                    Category?: string;
                    HasActiveSubscription?: boolean;
                    IncludeInactive?: boolean;
                    SubscriptionId?: string;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelDtoApiListResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelDtoApiListResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Hotels/search/with-manager": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search hotels with manager information (public endpoint for customers). */
        get: {
            parameters: {
                query?: {
                    Search?: string;
                    City?: string;
                    Country?: string;
                    Category?: string;
                    HasActiveSubscription?: boolean;
                    IncludeInactive?: boolean;
                    SubscriptionId?: string;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelWithManagerDtoApiListResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelWithManagerDtoApiListResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Hotels/nearby": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get hotels near a specific location (public endpoint for customers). */
        get: {
            parameters: {
                query: {
                    Latitude: number;
                    Longitude: number;
                    RadiusKm?: number;
                    MaxResults?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelWithDistanceDtoApiListResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelWithDistanceDtoApiListResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Hotels": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get all hotels with pagination (Admin only - includes all hotels regardless of status). */
        get: {
            parameters: {
                query?: {
                    Search?: string;
                    City?: string;
                    Country?: string;
                    Category?: string;
                    HasActiveSubscription?: boolean;
                    IncludeInactive?: boolean;
                    SubscriptionId?: string;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelDtoApiListResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        /** Create a new hotel (Manager only). */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The hotel creation data. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["CreateHotelDto"];
                    "text/json": components["schemas"]["CreateHotelDto"];
                    "application/*+json": components["schemas"]["CreateHotelDto"];
                };
            };
            responses: {
                /** @description Created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Hotels/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a hotel by ID. */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelDtoApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelDtoApiResponse"];
                    };
                };
            };
        };
        /** Update a hotel (Manager only - must own the hotel). */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    id: string;
                };
                cookie?: never;
            };
            /** @description The hotel update data. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["UpdateHotelDto"];
                    "text/json": components["schemas"]["UpdateHotelDto"];
                    "application/*+json": components["schemas"]["UpdateHotelDto"];
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelDtoApiResponse"];
                    };
                };
            };
        };
        post?: never;
        /** Delete a hotel (Manager only - must own the hotel). */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Hotels/my-hotels": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get hotels managed by the current manager with active subscription. */
        get: {
            parameters: {
                query?: {
                    Search?: string;
                    City?: string;
                    Country?: string;
                    Category?: string;
                    HasActiveSubscription?: boolean;
                    IncludeInactive?: boolean;
                    SubscriptionId?: string;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelDtoApiListResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Hotels/onboarding-status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get onboarding status for the current manager.
         *     Returns information about whether the manager has completed onboarding.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ManagerOnboardingStatusDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/hotels/{hotelId}/services": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get all services for a hotel (accessible by managers and customers). */
        get: {
            parameters: {
                query?: {
                    Search?: string;
                    IsActive?: boolean;
                    IsExternallyBookable?: boolean;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelServiceDtoApiListResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelServiceDtoApiListResponse"];
                    };
                };
            };
        };
        put?: never;
        /** Create a new hotel service (Manager only - must own the hotel). */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            /** @description The service creation data. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["CreateHotelServiceDto"];
                    "text/json": components["schemas"]["CreateHotelServiceDto"];
                    "application/*+json": components["schemas"]["CreateHotelServiceDto"];
                };
            };
            responses: {
                /** @description Created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelServiceDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelServiceDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/services/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a hotel service by ID. */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The service identifier. */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelServiceDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelServiceDtoApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/hotels/{hotelId}/services/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Update a hotel service (Manager only - must own the hotel). */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                    /** @description The service identifier. */
                    id: string;
                };
                cookie?: never;
            };
            /** @description The service update data. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["UpdateHotelServiceDto"];
                    "text/json": components["schemas"]["UpdateHotelServiceDto"];
                    "application/*+json": components["schemas"]["UpdateHotelServiceDto"];
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelServiceDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelServiceDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelServiceDtoApiResponse"];
                    };
                };
            };
        };
        post?: never;
        /** Delete a hotel service (Manager only - must own the hotel). */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                    /** @description The service identifier. */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Lists the current Manager's notifications (read + unread), most-recent-first. Feeds the header
         *     bell's unread badge on the frontend (polled). Isolation is carried by the `ManagerUserId`
         *     filter; StayApi.Api.Authorization.RequireRoleAttribute yields 401 (unauthenticated) / 403 (non-Manager).
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["NotificationDtoIReadOnlyListApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/{id}/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Marks one of the current Manager's notifications as read (Story 9.2, FR-12). Idempotent. Feeds the
         *     header bell's unread decrement on the frontend. Ownership is enforced server-side: a notification
         *     that does not exist or belongs to another Manager yields 404 (never a cross-tenant mutation).
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The notification identifier. */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Payments/room-reservation/intent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create Room Reservation Payment Intent
         * @description Creates a Stripe payment intent for a room reservation. Customer only.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The room reservation payment data. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["CreateRoomReservationPaymentIntentDto"];
                    "text/json": components["schemas"]["CreateRoomReservationPaymentIntentDto"];
                    "application/*+json": components["schemas"]["CreateRoomReservationPaymentIntentDto"];
                };
            };
            responses: {
                /** @description Payment intent created */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PaymentIntentResultDtoApiResponse"];
                    };
                };
                /** @description Invalid data */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PaymentIntentResultDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Customer role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Reservation not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PaymentIntentResultDtoApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Payments/service-reservation/intent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create Service Reservation Payment Intent
         * @description Creates a Stripe payment intent for a service reservation. Customer only.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The service reservation payment data. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["CreateServiceReservationPaymentIntentDto"];
                    "text/json": components["schemas"]["CreateServiceReservationPaymentIntentDto"];
                    "application/*+json": components["schemas"]["CreateServiceReservationPaymentIntentDto"];
                };
            };
            responses: {
                /** @description Payment intent created */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PaymentIntentResultDtoApiResponse"];
                    };
                };
                /** @description Invalid data */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PaymentIntentResultDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Customer role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Reservation not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PaymentIntentResultDtoApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Payments/subscription/intent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create Subscription Intent
         * @description Creates a subscription for a hotel. First-time subscribers get a trial period. Manager only.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The subscription creation data. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["CreateHotelSubscriptionDto"];
                    "text/json": components["schemas"]["CreateHotelSubscriptionDto"];
                    "application/*+json": components["schemas"]["CreateHotelSubscriptionDto"];
                };
            };
            responses: {
                /** @description Subscription intent created */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SubscriptionIntentResultDtoApiResponse"];
                    };
                };
                /** @description Invalid data */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SubscriptionIntentResultDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Manager role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Hotel or subscription not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SubscriptionIntentResultDtoApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Payments/subscription/hotel/{hotelId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Hotel Subscription
         * @description Gets the current subscription for a hotel. Manager only.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel ID. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelSubscriptionDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Manager role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description No active subscription */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelSubscriptionDtoApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Payments/subscription/hotel/{hotelId}/change": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Change Hotel Subscription
         * @description Changes a hotel's subscription to a different plan. Manager only.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel ID. */
                    hotelId: string;
                };
                cookie?: never;
            };
            /** @description The subscription change data. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["ChangeHotelSubscriptionDto"];
                    "text/json": components["schemas"]["ChangeHotelSubscriptionDto"];
                    "application/*+json": components["schemas"]["ChangeHotelSubscriptionDto"];
                };
            };
            responses: {
                /** @description Subscription changed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelSubscriptionDtoApiResponse"];
                    };
                };
                /** @description Invalid data */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelSubscriptionDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Manager role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Hotel or subscription not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelSubscriptionDtoApiResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Payments/subscription/hotel/{hotelId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cancel Hotel Subscription
         * @description Cancels a hotel's subscription. Features remain until end of billing period. Manager only.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel ID. */
                    hotelId: string;
                };
                cookie?: never;
            };
            /** @description The cancellation data. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["CancelHotelSubscriptionDto"];
                    "text/json": components["schemas"]["CancelHotelSubscriptionDto"];
                    "application/*+json": components["schemas"]["CancelHotelSubscriptionDto"];
                };
            };
            responses: {
                /** @description Subscription cancelled */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CancellationResultDtoApiResponse"];
                    };
                };
                /** @description Invalid data */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CancellationResultDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Manager role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Hotel or subscription not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["CancellationResultDtoApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Payments/subscription/hotel/{hotelId}/trial-eligibility": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Check Trial Eligibility
         * @description Checks if a hotel is eligible for a trial subscription. Manager only.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel ID. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TrialEligibilityDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Manager role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Payments/subscription/hotel/{hotelId}/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Hotel Subscription History
         * @description Gets all subscription history for a hotel. Manager only.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel ID. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelSubscriptionDtoIReadOnlyListApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Manager role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Hotel not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["HotelSubscriptionDtoIReadOnlyListApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Payments/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Payment by ID
         * @description Gets a payment by its ID.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The payment ID. */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PaymentDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Payment not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PaymentDtoApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/receptionist/rooms/{roomId}/cleaning": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Mark a room as cleaning (Housekeeping only). */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The room identifier. */
                    roomId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/receptionist/rooms/{roomId}/available": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Mark a room as available after cleaning (Housekeeping only). */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The room identifier. */
                    roomId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/receptionist/rooms/{roomId}/maintenance": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Mark a room as under maintenance/in review (Housekeeping only). */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The room identifier. */
                    roomId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/receptionist/reservations/{reservationId}/checkin": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Check in a reservation (Front Desk only). */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The reservation identifier. */
                    reservationId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ReservationDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ReservationDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ReservationDtoApiResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/receptionist/reservations/{reservationId}/checkout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Check out a reservation (Front Desk only). */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The reservation identifier. */
                    reservationId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ReservationDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ReservationDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ReservationDtoApiResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/receptionist/reservations/code/{code}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get reservation by code (Front Desk only). */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The reservation code. */
                    code: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ReservationDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ReservationDtoApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/reservations/{reservationId}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Confirms a reservation, triggering the "confirmed" event (email + attached PDF). Idempotent. */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The reservation identifier. */
                    reservationId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ConfirmationResultDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/reservations/validate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Validates a reservation QR token for the caller's hotel and, when valid, consumes it atomically
         *     at the first success.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The token to validate. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["QrValidationRequestDto"];
                    "text/json": components["schemas"]["QrValidationRequestDto"];
                    "application/*+json": components["schemas"]["QrValidationRequestDto"];
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["QrValidationResultDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/RoomReservations/hotels/{hotelId}/available-rooms": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get available rooms for a hotel with filters (accessible to customers and hotel manager). */
        get: {
            parameters: {
                query?: {
                    Search?: string;
                    Category?: string;
                    MinCapacity?: number;
                    MaxCapacity?: number;
                    MinPrice?: number;
                    MaxPrice?: number;
                    Status?: components["schemas"]["RoomStatus"];
                    Floor?: number;
                    CheckInDate?: string;
                    CheckOutDate?: string;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiListResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/RoomReservations/hotels/{hotelId}/reservations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get hotel reservations (Manager only - must own the hotel). */
        get: {
            parameters: {
                query?: {
                    Status?: components["schemas"]["ReservationStatus"];
                    CheckInFrom?: string;
                    CheckInTo?: string;
                    Search?: string;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomReservationDtoApiListResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        /** Create a new room reservation (Customer only). */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            /** @description The reservation creation data. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["CreateRoomReservationDto"];
                    "text/json": components["schemas"]["CreateRoomReservationDto"];
                    "application/*+json": components["schemas"]["CreateRoomReservationDto"];
                };
            };
            responses: {
                /** @description Created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomReservationDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomReservationDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/RoomReservations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get reservation by ID (Customer can only view their own, Manager can view hotel reservations). */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The reservation identifier. */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomReservationDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomReservationDtoApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/RoomReservations/code/{code}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get reservation by code (Customer can only view their own). */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The reservation code. */
                    code: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomReservationDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomReservationDtoApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/RoomReservations/my-reservations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get current customer's reservations (Customer only). */
        get: {
            parameters: {
                query?: {
                    Status?: components["schemas"]["ReservationStatus"];
                    CheckInFrom?: string;
                    CheckInTo?: string;
                    Search?: string;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomReservationDtoApiListResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/RoomReservations/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel a reservation (Customer can only cancel their own pending/confirmed reservations). */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The reservation identifier. */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/RoomReservations/{id}/services": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Replaces the whole service basket of a pending reservation (Story 2.0 / D6 combined cart).
         *     REPLACE semantics: the supplied lines become the complete basket; an empty list removes them all.
         *     Refused once a payment is engaged, so the authorised amount can never drift from the total.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The reservation identifier. */
                    id: string;
                };
                cookie?: never;
            };
            /** @description The new basket. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["ReplaceReservationServicesDto"];
                    "text/json": components["schemas"]["ReplaceReservationServicesDto"];
                    "application/*+json": components["schemas"]["ReplaceReservationServicesDto"];
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomReservationDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/RoomReservations/rooms/{roomId}/availability": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Check room availability for specific dates. */
        get: {
            parameters: {
                query?: {
                    /** @description Check-in date. */
                    checkIn?: string;
                    /** @description Check-out date. */
                    checkOut?: string;
                };
                header?: never;
                path: {
                    /** @description The room identifier. */
                    roomId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomAvailabilityDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Rooms/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get room details by ID (accessible to all authenticated users). */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The room identifier. */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDetailDtoApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDetailDtoApiResponse"];
                    };
                };
            };
        };
        /** Update a room (Manager only - must own the hotel). */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The room identifier. */
                    id: string;
                };
                cookie?: never;
            };
            /** @description The room update data. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["UpdateRoomDto"];
                    "text/json": components["schemas"]["UpdateRoomDto"];
                    "application/*+json": components["schemas"]["UpdateRoomDto"];
                };
            };
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiResponse"];
                    };
                };
            };
        };
        post?: never;
        /** Delete a room (Manager only - must own the hotel). */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The room identifier. */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Rooms/hotel/{hotelId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get rooms by hotel ID with pagination (public endpoint). */
        get: {
            parameters: {
                query?: {
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiListResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiListResponse"];
                    };
                };
            };
        };
        put?: never;
        /** Create a new room (Manager only - must own the hotel). */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            /** @description The room creation data. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["CreateRoomDto"];
                    "text/json": components["schemas"]["CreateRoomDto"];
                    "application/*+json": components["schemas"]["CreateRoomDto"];
                };
            };
            responses: {
                /** @description Created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Rooms/hotel/{hotelId}/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search rooms by hotel ID with filters and pagination (public endpoint for customers). */
        get: {
            parameters: {
                query?: {
                    Search?: string;
                    Category?: string;
                    MinCapacity?: number;
                    MaxCapacity?: number;
                    MinPrice?: number;
                    MaxPrice?: number;
                    Status?: components["schemas"]["RoomStatus"];
                    Floor?: number;
                    CheckInDate?: string;
                    CheckOutDate?: string;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiListResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiListResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Rooms/hotel/{hotelId}/available": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get available rooms for a hotel with filters (public endpoint for customers). */
        get: {
            parameters: {
                query?: {
                    Search?: string;
                    Category?: string;
                    MinCapacity?: number;
                    MaxCapacity?: number;
                    MinPrice?: number;
                    MaxPrice?: number;
                    Status?: components["schemas"]["RoomStatus"];
                    Floor?: number;
                    CheckInDate?: string;
                    CheckOutDate?: string;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiListResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomDtoApiListResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Rooms/hotel/{hotelId}/count": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get room count for a hotel (Manager only - must own the hotel). */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The hotel identifier. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["RoomCountDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/service-reservations/my-reservations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get all service reservations for the current customer. */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ServiceReservationDtoIReadOnlyListApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/service-reservations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a service reservation by ID (Customer only - must own the reservation). */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The reservation identifier. */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OK */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ServiceReservationDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not Found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ServiceReservationDtoApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/service-reservations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a new service reservation (Customer only). */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The reservation creation data. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["CreateServiceReservationDto"];
                    "text/json": components["schemas"]["CreateServiceReservationDto"];
                    "application/*+json": components["schemas"]["CreateServiceReservationDto"];
                };
            };
            responses: {
                /** @description Created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ServiceReservationDtoApiResponse"];
                    };
                };
                /** @description Bad Request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ServiceReservationDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/webhooks/stripe/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Test Payment Status Update
         * @description Test endpoint to simulate webhook payment status update. For development/testing only.
         */
        post: {
            parameters: {
                query?: {
                    /** @description The Stripe payment intent ID. */
                    paymentIntentId?: string;
                    /** @description The payment status to set. */
                    status?: components["schemas"]["PaymentStatus"];
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Payment status updated successfully */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Payment not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/webhooks/stripe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Stripe Webhook
         * @description Receives and processes Stripe webhook events.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Webhook processed successfully */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Invalid webhook payload */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Subscriptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get All Subscriptions
         * @description Gets paginated list of subscriptions with filtering. Admin and Manager access.
         */
        get: {
            parameters: {
                query?: {
                    PageNumber?: number;
                    PageSize?: number;
                    Search?: string;
                    MinPrice?: number;
                    MaxPrice?: number;
                    IsActive?: boolean;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SubscriptionDtoApiListResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Admin or Manager role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        /**
         * Create Subscription
         * @description Creates a new subscription. Admin only.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            /** @description The subscription creation data. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["CreateSubscriptionDto"];
                    "text/json": components["schemas"]["CreateSubscriptionDto"];
                    "application/*+json": components["schemas"]["CreateSubscriptionDto"];
                };
            };
            responses: {
                /** @description Subscription created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SubscriptionDtoApiResponse"];
                    };
                };
                /** @description Invalid data or duplicate name */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SubscriptionDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Admin role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Subscriptions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Subscription by ID
         * @description Gets a subscription by its ID. Admin and Manager access.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The subscription ID. */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SubscriptionDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Admin or Manager role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Subscription not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SubscriptionDtoApiResponse"];
                    };
                };
            };
        };
        /**
         * Update Subscription
         * @description Updates an existing subscription. Admin only.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The subscription ID. */
                    id: string;
                };
                cookie?: never;
            };
            /** @description The subscription update data. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["UpdateSubscriptionDto"];
                    "text/json": components["schemas"]["UpdateSubscriptionDto"];
                    "application/*+json": components["schemas"]["UpdateSubscriptionDto"];
                };
            };
            responses: {
                /** @description Subscription updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SubscriptionDtoApiResponse"];
                    };
                };
                /** @description Invalid data or duplicate name */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SubscriptionDtoApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Admin role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Subscription not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SubscriptionDtoApiResponse"];
                    };
                };
            };
        };
        post?: never;
        /**
         * Delete Subscription
         * @description Soft deletes a subscription. Admin only.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description The subscription ID. */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Subscription deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Admin role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Subscription not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get All Users
         * @description Gets paginated list of all users except admins. Admin only.
         */
        get: {
            parameters: {
                query?: {
                    Role?: components["schemas"]["UserRole"];
                    Search?: string;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["UserDtoApiListResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Admin role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Users/hotels/{hotelId}/customers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Customers by Hotel
         * @description Gets paginated list of customers for a hotel. Manager only.
         */
        get: {
            parameters: {
                query?: {
                    Search?: string;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path: {
                    /** @description Hotel ID. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["UserDtoApiListResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Manager role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Hotel not found or access denied */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["UserDtoApiListResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Users/hotels/{hotelId}/receptionists": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get Receptionists by Hotel
         * @description Gets paginated list of receptionists for a hotel. Manager only.
         */
        get: {
            parameters: {
                query?: {
                    Search?: string;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path: {
                    /** @description Hotel ID. */
                    hotelId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["UserDtoApiListResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden - Manager role required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Hotel not found or access denied */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["UserDtoApiListResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Users/receptionists": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List manager receptionists
         * @description Paginated receptionists for all hotels managed by the authenticated manager.
         */
        get: {
            parameters: {
                query?: {
                    Search?: string;
                    HotelId?: string;
                    PageNumber?: number;
                    PageSize?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ManagerReceptionistListItemDtoApiListResponse"];
                    };
                };
                /** @description Bad request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ManagerReceptionistListItemDtoApiListResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Forbidden */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Users/receptionists/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete receptionist
         * @description Soft-deletes a receptionist account.
         */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Receptionist user identifier. */
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Bad request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/Users/receptionists/{id}/active": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Set receptionist active state
         * @description Enables or disables login for the receptionist.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Receptionist user identifier. */
                    id: string;
                };
                cookie?: never;
            };
            /** @description Desired active state. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["SetReceptionistActiveRequestDto"];
                    "text/json": components["schemas"]["SetReceptionistActiveRequestDto"];
                    "application/*+json": components["schemas"]["SetReceptionistActiveRequestDto"];
                };
            };
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Bad request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/Users/receptionists/{id}/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set receptionist password
         * @description Manager-initiated password reset.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    /** @description Receptionist user identifier. */
                    id: string;
                };
                cookie?: never;
            };
            /** @description New password and confirmation. */
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["ManagerSetReceptionistPasswordRequestDto"];
                    "text/json": components["schemas"]["ManagerSetReceptionistPasswordRequestDto"];
                    "application/*+json": components["schemas"]["ManagerSetReceptionistPasswordRequestDto"];
                };
            };
            responses: {
                /** @description Success */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Bad request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
                /** @description Not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ApiResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        AdminDashboardDto: {
            /** Format: int32 */
            totalHotels?: number;
            /** Format: int32 */
            activeSubscribedHotels?: number;
            /** Format: int32 */
            trialHotels?: number;
            /** Format: int32 */
            paidSubscribedHotels?: number;
            /** Format: int32 */
            totalManagers?: number;
            /** Format: int32 */
            totalCustomers?: number;
            /** Format: int32 */
            monthlyReservations?: number;
            /** Format: double */
            monthlyRevenue?: number;
            /** Format: int32 */
            newHotelsThisMonth?: number;
            /** Format: int32 */
            newCustomersThisMonth?: number;
        };
        AdminHotelDto: {
            /** Format: uuid */
            id?: string;
            name?: string | null;
            category?: string | null;
            address?: string | null;
            city?: string | null;
            country?: string | null;
            postalCode?: string | null;
            /** Format: double */
            latitude?: number | null;
            /** Format: double */
            longitude?: number | null;
            phone?: string | null;
            email?: string | null;
            currency?: string | null;
            locale?: string | null;
            logoUrl?: string | null;
            description?: string | null;
            isDeleted?: boolean;
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            updatedAt?: string | null;
            manager?: components["schemas"]["ManagerSummaryDto"];
            subscription?: components["schemas"]["SubscriptionSummaryDto"];
        };
        AdminHotelDtoApiListResponse: {
            readonly success?: boolean;
            readonly data?: components["schemas"]["AdminHotelDto"][] | null;
            pagination?: components["schemas"]["PaginationMeta"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        AdminHotelDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["AdminHotelDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        AdminSettingsDto: {
            /** Format: uuid */
            id?: string;
            emailNotifications?: boolean;
            pushNotifications?: boolean;
            weeklyReports?: boolean;
            securityAlerts?: boolean;
            twoFactorAuth?: boolean;
            /** Format: int32 */
            sessionTimeoutMinutes?: number;
            ipWhitelist?: string | null;
            autoBackup?: boolean;
            backupFrequency?: string | null;
            /** Format: int32 */
            dataRetentionDays?: number;
            defaultCurrency?: string | null;
            defaultLocale?: string | null;
            timezone?: string | null;
            /** Format: int32 */
            maxUsersPerHotel?: number;
            /** Format: int32 */
            maxRoomsPerHotel?: number;
            /** Format: int32 */
            trialDays?: number;
            smtpHost?: string | null;
            /** Format: int32 */
            smtpPort?: number;
            smtpUser?: string | null;
            smtpUseSsl?: boolean;
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            updatedAt?: string | null;
        };
        AdminSettingsDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["AdminSettingsDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        ApiResponse: {
            readonly success?: boolean;
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        AuthResponseDto: {
            /** Format: uuid */
            userId?: string;
            email?: string | null;
            firstName?: string | null;
            lastName?: string | null;
            role?: components["schemas"]["UserRole"];
            accessToken?: string | null;
            /** Format: date-time */
            accessTokenExpiration?: string;
            refreshToken?: string | null;
            /** Format: date-time */
            refreshTokenExpiration?: string;
        };
        AuthResponseDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["AuthResponseDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        BrandingDto: {
            /** Format: uuid */
            hotelId?: string;
            logoUrl?: string | null;
            primaryColor?: string | null;
            defaultLanguage?: string | null;
        };
        BrandingDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["BrandingDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        CancelHotelSubscriptionDto: {
            reason?: string | null;
            cancelImmediately?: boolean;
        };
        /** @description DTO for cancellation result. */
        CancellationResultDto: {
            /**
             * Format: date-time
             * @description Gets or sets the effective cancellation date.
             */
            cancellationEffectiveDate?: string;
        };
        CancellationResultDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["CancellationResultDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        ChangeHotelSubscriptionDto: {
            /** Format: uuid */
            newSubscriptionId?: string;
            prorate?: boolean;
        };
        ChangePasswordRequestDto: {
            currentPassword?: string | null;
            newPassword?: string | null;
            confirmPassword?: string | null;
        };
        ConfirmationResultDto: {
            /** Format: uuid */
            reservationId?: string;
            /** Format: double */
            grandTotal?: number;
            droppedServices?: components["schemas"]["ReservationServiceLineDto"][] | null;
        };
        ConfirmationResultDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["ConfirmationResultDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        CreateHotelDto: {
            name: string | null;
            category?: string | null;
            address?: string | null;
            city?: string | null;
            country?: string | null;
            postalCode?: string | null;
            /** Format: double */
            latitude?: number | null;
            /** Format: double */
            longitude?: number | null;
            phone?: string | null;
            email?: string | null;
            rcs?: string | null;
            nif?: string | null;
            stat?: string | null;
            currency?: string | null;
            locale?: string | null;
            description?: string | null;
        };
        CreateHotelServiceDto: {
            name?: string | null;
            /** Format: double */
            price?: number;
            unit?: string | null;
            description?: string | null;
            isActive?: boolean;
            /** Format: int32 */
            externalQuantity?: number;
            isExternallyBookable?: boolean;
        };
        CreateHotelSubscriptionDto: {
            /** Format: uuid */
            hotelId?: string;
            /** Format: uuid */
            subscriptionId?: string;
            paymentMethodId?: string | null;
            successUrl?: string | null;
            cancelUrl?: string | null;
        };
        CreateReservationServiceLineDto: {
            /** Format: uuid */
            serviceId: string;
            /** Format: int32 */
            quantity?: number;
            /** Format: date-time */
            serviceDate: string;
            /** Format: time */
            startTime?: string | null;
            /** Format: time */
            endTime?: string | null;
        };
        CreateRoomDto: {
            number: string | null;
            category?: string | null;
            /** Format: int32 */
            capacity?: number;
            /** Format: double */
            price?: number;
            description?: string | null;
            amenities?: string | null;
            /** Format: int32 */
            floor?: number | null;
            includedServices?: components["schemas"]["RoomIncludedServiceInputDto"][] | null;
        };
        CreateRoomReservationDto: {
            /** Format: uuid */
            roomId: string;
            /** Format: date-time */
            checkInDate: string;
            /** Format: date-time */
            checkOutDate: string;
            /** Format: int32 */
            numberOfGuests?: number;
            paymentMethod?: components["schemas"]["PaymentMethod"];
            specialRequests?: string | null;
            services?: components["schemas"]["CreateReservationServiceLineDto"][] | null;
        };
        CreateRoomReservationPaymentIntentDto: {
            /** Format: uuid */
            roomReservationId?: string;
        };
        CreateServiceReservationDto: {
            /** Format: uuid */
            serviceId?: string;
            /** Format: int32 */
            quantity?: number;
            /** Format: date-time */
            serviceDate?: string;
            /** Format: time */
            startTime?: string | null;
            /** Format: time */
            endTime?: string | null;
            notes?: string | null;
        };
        CreateServiceReservationPaymentIntentDto: {
            /** Format: uuid */
            serviceReservationId?: string;
        };
        CreateSubscriptionDto: {
            name: string | null;
            /** Format: double */
            price: number;
            description?: string | null;
            /** Format: int32 */
            maxRooms?: number | null;
            /** Format: int32 */
            maxUsers?: number | null;
            isActive?: boolean;
            /** Format: int32 */
            trialPeriodDays?: number | null;
        };
        /** @description DTO for current user response. */
        CurrentUserDto: {
            /**
             * Format: uuid
             * @description Gets or sets the user ID.
             */
            userId?: string;
            /** @description Gets or sets the email. */
            email?: string | null;
            /** @description Gets or sets the role. */
            role?: string | null;
        };
        CurrentUserDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["CurrentUserDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        /**
         * Format: int32
         * @enum {integer}
         */
        EmailOutboxStatus: 1 | 2 | 3 | 4;
        EmailPreviewRequestDto: {
            event?: string | null;
            language?: string | null;
            subject?: string | null;
            bodyTemplate?: string | null;
        };
        EmailPreviewResultDto: {
            event?: string | null;
            language?: string | null;
            subject?: string | null;
            body?: string | null;
            logoUrl?: string | null;
            primaryColor?: string | null;
        };
        EmailPreviewResultDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["EmailPreviewResultDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        EmailSendLogDto: {
            /** Format: uuid */
            id?: string;
            /** Format: uuid */
            reservationId?: string;
            reservationCode?: string | null;
            recipientMasked?: string | null;
            event?: components["schemas"]["ReservationEvent"];
            status?: components["schemas"]["EmailOutboxStatus"];
            error?: string | null;
            /** Format: date-time */
            createdAt?: string;
        };
        EmailSendLogDtoApiListResponse: {
            readonly success?: boolean;
            readonly data?: components["schemas"]["EmailSendLogDto"][] | null;
            pagination?: components["schemas"]["PaginationMeta"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        EmailTemplateDto: {
            /** Format: uuid */
            hotelId?: string;
            event?: string | null;
            language?: string | null;
            subject?: string | null;
            bodyTemplate?: string | null;
            isDefault?: boolean;
        };
        EmailTemplateDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["EmailTemplateDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        EmailTemplatesResponseDto: {
            defaultLanguage?: string | null;
            supportedLanguages?: string[] | null;
            events?: string[] | null;
            variables?: string[] | null;
            templates?: components["schemas"]["EmailTemplateDto"][] | null;
        };
        EmailTemplatesResponseDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["EmailTemplatesResponseDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        /**
         * Format: int32
         * @enum {integer}
         */
        FileCategory: 0 | 1 | 2 | 3;
        FileResultDto: {
            /** Format: uuid */
            id?: string;
            fileName?: string | null;
            filePath?: string | null;
            contentType?: string | null;
            /** Format: int64 */
            fileSize?: number;
            category?: components["schemas"]["FileCategory"];
            url?: string | null;
            /** Format: date-time */
            createdAt?: string;
        };
        FileResultDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["FileResultDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        ForgotPasswordRequestDto: {
            email?: string | null;
        };
        HotelDashboardDto: {
            /** Format: uuid */
            hotelId?: string;
            hotelName?: string | null;
            /** Format: int32 */
            todayCheckIns?: number;
            /** Format: int32 */
            todayCheckOuts?: number;
            /** Format: double */
            currentOccupancyRate?: number;
            /** Format: double */
            currentMonthRevenue?: number;
            /** Format: int32 */
            pendingReservations?: number;
            /** Format: int32 */
            totalRooms?: number;
            /** Format: int32 */
            availableRooms?: number;
            currency?: string | null;
        };
        HotelDto: {
            /** Format: uuid */
            id?: string;
            name?: string | null;
            category?: string | null;
            address?: string | null;
            city?: string | null;
            country?: string | null;
            postalCode?: string | null;
            /** Format: double */
            latitude?: number | null;
            /** Format: double */
            longitude?: number | null;
            phone?: string | null;
            email?: string | null;
            rcs?: string | null;
            nif?: string | null;
            stat?: string | null;
            /** Format: int32 */
            roomCount?: number;
            currency?: string | null;
            locale?: string | null;
            logoUrl?: string | null;
            description?: string | null;
            /** Format: uuid */
            subscriptionId?: string | null;
            /** Format: date-time */
            createdAt?: string;
        };
        HotelDtoApiListResponse: {
            readonly success?: boolean;
            readonly data?: components["schemas"]["HotelDto"][] | null;
            pagination?: components["schemas"]["PaginationMeta"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        HotelDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["HotelDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        HotelServiceDto: {
            /** Format: uuid */
            id?: string;
            /** Format: uuid */
            hotelId?: string;
            name?: string | null;
            /** Format: double */
            price?: number;
            unit?: string | null;
            description?: string | null;
            isActive?: boolean;
            /** Format: int32 */
            externalQuantity?: number;
            isExternallyBookable?: boolean;
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            updatedAt?: string | null;
        };
        HotelServiceDtoApiListResponse: {
            readonly success?: boolean;
            readonly data?: components["schemas"]["HotelServiceDto"][] | null;
            pagination?: components["schemas"]["PaginationMeta"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        HotelServiceDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["HotelServiceDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        HotelSubscriptionDto: {
            /** Format: uuid */
            id?: string;
            /** Format: uuid */
            hotelId?: string;
            hotelName?: string | null;
            /** Format: uuid */
            subscriptionId?: string;
            subscriptionName?: string | null;
            /** Format: double */
            price?: number;
            status?: components["schemas"]["SubscriptionStatus"];
            isTrial?: boolean;
            /** Format: date-time */
            trialEndDate?: string | null;
            /** Format: date-time */
            startDate?: string;
            /** Format: date-time */
            endDate?: string | null;
            /** Format: date-time */
            nextBillingDate?: string | null;
            /** Format: date-time */
            cancellationRequestedAt?: string | null;
            /** Format: date-time */
            cancellationEffectiveDate?: string | null;
            areFeaturesAvailable?: boolean;
            /** Format: date-time */
            createdAt?: string;
        };
        HotelSubscriptionDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["HotelSubscriptionDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        HotelSubscriptionDtoIReadOnlyListApiResponse: {
            readonly success?: boolean;
            readonly data?: components["schemas"]["HotelSubscriptionDto"][] | null;
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        HotelWithDistanceDto: {
            /** Format: uuid */
            id?: string;
            name?: string | null;
            category?: string | null;
            address?: string | null;
            city?: string | null;
            country?: string | null;
            postalCode?: string | null;
            /** Format: double */
            latitude?: number | null;
            /** Format: double */
            longitude?: number | null;
            phone?: string | null;
            email?: string | null;
            rcs?: string | null;
            nif?: string | null;
            stat?: string | null;
            /** Format: int32 */
            roomCount?: number;
            currency?: string | null;
            locale?: string | null;
            logoUrl?: string | null;
            description?: string | null;
            /** Format: uuid */
            subscriptionId?: string | null;
            /** Format: date-time */
            createdAt?: string;
            /** Format: double */
            distanceKm?: number;
        };
        HotelWithDistanceDtoApiListResponse: {
            readonly success?: boolean;
            readonly data?: components["schemas"]["HotelWithDistanceDto"][] | null;
            pagination?: components["schemas"]["PaginationMeta"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        HotelWithManagerDto: {
            /** Format: uuid */
            id?: string;
            name?: string | null;
            category?: string | null;
            address?: string | null;
            city?: string | null;
            country?: string | null;
            postalCode?: string | null;
            /** Format: double */
            latitude?: number | null;
            /** Format: double */
            longitude?: number | null;
            phone?: string | null;
            email?: string | null;
            currency?: string | null;
            locale?: string | null;
            logoUrl?: string | null;
            description?: string | null;
            /** Format: date-time */
            createdAt?: string;
            manager?: components["schemas"]["ManagerSummaryDto"];
        };
        HotelWithManagerDtoApiListResponse: {
            readonly success?: boolean;
            readonly data?: components["schemas"]["HotelWithManagerDto"][] | null;
            pagination?: components["schemas"]["PaginationMeta"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        LoginRequestDto: {
            email?: string | null;
            password?: string | null;
        };
        ManagerOnboardingStatusDto: {
            isOnboardingComplete?: boolean;
            hasHotels?: boolean;
            hasActiveSubscription?: boolean;
            isEligibleForTrial?: boolean;
            /** Format: uuid */
            pendingHotelId?: string | null;
            pendingHotelName?: string | null;
            /** Format: int32 */
            totalHotels?: number;
            /** Format: int32 */
            hotelsWithSubscription?: number;
        };
        ManagerOnboardingStatusDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["ManagerOnboardingStatusDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        ManagerReceptionistListItemDto: {
            /** Format: uuid */
            id?: string;
            firstName?: string | null;
            lastName?: string | null;
            email?: string | null;
            phone?: string | null;
            profilePicture?: string | null;
            role?: components["schemas"]["UserRole"];
            isActive?: boolean;
            /** Format: date-time */
            createdAt?: string;
            /** Format: uuid */
            hotelId?: string;
            hotelName?: string | null;
            hotelCity?: string | null;
            receptionistType?: components["schemas"]["ReceptionistType"];
            permissions?: components["schemas"]["ReceptionistPermission"];
        };
        ManagerReceptionistListItemDtoApiListResponse: {
            readonly success?: boolean;
            readonly data?: components["schemas"]["ManagerReceptionistListItemDto"][] | null;
            pagination?: components["schemas"]["PaginationMeta"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        ManagerSetReceptionistPasswordRequestDto: {
            newPassword?: string | null;
            confirmPassword?: string | null;
        };
        ManagerSummaryDto: {
            /** Format: uuid */
            id?: string;
            firstName?: string | null;
            lastName?: string | null;
            email?: string | null;
            phone?: string | null;
        };
        MonthlyRevenueDto: {
            /** Format: int32 */
            year?: number;
            /** Format: int32 */
            month?: number;
            /** Format: double */
            roomReservationRevenue?: number;
            /** Format: double */
            serviceReservationRevenue?: number;
            /** Format: double */
            totalRevenue?: number;
            currency?: string | null;
        };
        MonthlyRoomReservationsDto: {
            /** Format: int32 */
            year?: number;
            /** Format: int32 */
            month?: number;
            /** Format: int32 */
            confirmedCount?: number;
            /** Format: int32 */
            cancelledCount?: number;
            /** Format: int32 */
            totalCount?: number;
            /** Format: double */
            occupancyRate?: number;
        };
        MonthlySubscriptionsDto: {
            /** Format: int32 */
            year?: number;
            /** Format: int32 */
            month?: number;
            /** Format: int32 */
            newSubscriptions?: number;
            /** Format: int32 */
            cancelledSubscriptions?: number;
            /** Format: int32 */
            activeSubscriptions?: number;
            /** Format: double */
            revenue?: number;
        };
        NotificationDto: {
            /** Format: uuid */
            id?: string;
            /** Format: uuid */
            hotelId?: string;
            /** Format: uuid */
            reservationId?: string;
            event?: components["schemas"]["ReservationEvent"];
            isRead?: boolean;
            /** Format: date-time */
            createdAt?: string;
        };
        NotificationDtoIReadOnlyListApiResponse: {
            readonly success?: boolean;
            readonly data?: components["schemas"]["NotificationDto"][] | null;
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        PaginationMeta: {
            /** Format: int32 */
            page?: number;
            /** Format: int32 */
            pageSize?: number;
            /** Format: int32 */
            totalCount?: number;
            /** Format: int32 */
            totalPages?: number;
            hasPreviousPage?: boolean;
            hasNextPage?: boolean;
        };
        PaymentDto: {
            /** Format: uuid */
            id?: string;
            paymentType?: components["schemas"]["PaymentType"];
            paymentMethod?: components["schemas"]["PaymentMethod"];
            status?: components["schemas"]["PaymentStatus"];
            /** Format: double */
            amount?: number;
            currency?: string | null;
            stripePaymentIntentId?: string | null;
            /** Format: uuid */
            roomReservationId?: string | null;
            /** Format: uuid */
            serviceReservationId?: string | null;
            /** Format: uuid */
            subscriptionHistoryId?: string | null;
            /** Format: uuid */
            hotelId?: string;
            /** Format: uuid */
            customerId?: string | null;
            failureReason?: string | null;
            /** Format: date-time */
            paidAt?: string | null;
            /** Format: date-time */
            createdAt?: string;
        };
        PaymentDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["PaymentDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        PaymentIntentResultDto: {
            /** Format: uuid */
            paymentId?: string;
            clientSecret?: string | null;
            paymentIntentId?: string | null;
            /** Format: int64 */
            amountInCents?: number;
            currency?: string | null;
            publishableKey?: string | null;
        };
        PaymentIntentResultDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["PaymentIntentResultDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        /**
         * Format: int32
         * @enum {integer}
         */
        PaymentMethod: 1 | 2 | 3 | 4 | 5;
        /**
         * Format: int32
         * @enum {integer}
         */
        PaymentStatus: 1 | 2 | 3 | 4 | 5 | 6 | 7;
        /**
         * Format: int32
         * @enum {integer}
         */
        PaymentType: 1 | 2 | 3;
        PaymentsByServiceDto: {
            serviceName?: string | null;
            /** Format: uuid */
            serviceId?: string;
            /** Format: int32 */
            paymentCount?: number;
            /** Format: double */
            totalRevenue?: number;
        };
        PdfPreviewRequestDto: {
            language?: string | null;
            contextualMentions?: string | null;
        };
        PdfPreviewResultDto: {
            pdfBase64?: string | null;
            fileName?: string | null;
            contentType?: string | null;
        };
        PdfPreviewResultDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["PdfPreviewResultDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        PdfTemplateDto: {
            /** Format: uuid */
            hotelId?: string;
            language?: string | null;
            contextualMentions?: string | null;
            isDefault?: boolean;
        };
        PdfTemplateDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["PdfTemplateDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        PdfTemplatesResponseDto: {
            defaultLanguage?: string | null;
            supportedLanguages?: string[] | null;
            templates?: components["schemas"]["PdfTemplateDto"][] | null;
            logoUrl?: string | null;
            primaryColor?: string | null;
        };
        PdfTemplatesResponseDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["PdfTemplatesResponseDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        ProblemDetails: {
            type?: string | null;
            title?: string | null;
            /** Format: int32 */
            status?: number | null;
            detail?: string | null;
            instance?: string | null;
        } & {
            [key: string]: unknown;
        };
        QrValidationRequestDto: {
            token?: string | null;
        };
        QrValidationReservationDto: {
            reservationCode?: string | null;
            customerName?: string | null;
            roomNumber?: string | null;
            /** Format: date-time */
            checkInDate?: string;
            /** Format: date-time */
            checkOutDate?: string;
        };
        /**
         * Format: int32
         * @enum {integer}
         */
        QrValidationResult: 1 | 2 | 3 | 4;
        QrValidationResultDto: {
            status?: components["schemas"]["QrValidationResult"];
            reservation?: components["schemas"]["QrValidationReservationDto"];
        };
        QrValidationResultDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["QrValidationResultDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        /**
         * Format: int32
         * @enum {integer}
         */
        ReceptionistPermission: 0 | 1 | 2 | 4 | 8;
        /**
         * Format: int32
         * @enum {integer}
         */
        ReceptionistType: 1 | 2;
        RefreshTokenRequestDto: {
            accessToken?: string | null;
            refreshToken?: string | null;
        };
        RegisterCustomerRequestDto: {
            firstName?: string | null;
            lastName?: string | null;
            email?: string | null;
            password?: string | null;
            confirmPassword?: string | null;
            phone?: string | null;
            country?: string | null;
            city?: string | null;
            address?: string | null;
            postalCode?: string | null;
        };
        RegisterManagerRequestDto: {
            firstName?: string | null;
            lastName?: string | null;
            email?: string | null;
            password?: string | null;
            confirmPassword?: string | null;
            phone?: string | null;
        };
        RegisterReceptionistRequestDto: {
            firstName?: string | null;
            lastName?: string | null;
            email?: string | null;
            password?: string | null;
            confirmPassword?: string | null;
            phone?: string | null;
            /** Format: uuid */
            hotelId?: string;
            receptionistType?: components["schemas"]["ReceptionistType"];
            permissions?: components["schemas"]["ReceptionistPermission"];
        };
        /** @description Request model for reordering images. */
        ReorderImagesRequest: {
            imageIds?: string[] | null;
        };
        ReplaceReservationServicesDto: {
            services?: components["schemas"]["CreateReservationServiceLineDto"][] | null;
        };
        ReservationDto: {
            /** Format: uuid */
            id?: string;
            reservationCode?: string | null;
            /** Format: uuid */
            hotelId?: string;
            /** Format: uuid */
            roomId?: string;
            roomNumber?: string | null;
            /** Format: uuid */
            customerId?: string;
            customerName?: string | null;
            /** Format: date-time */
            checkInDate?: string;
            /** Format: date-time */
            checkOutDate?: string;
            /** Format: date-time */
            actualCheckIn?: string | null;
            /** Format: date-time */
            actualCheckOut?: string | null;
            /** Format: int32 */
            numberOfGuests?: number;
            /** Format: int32 */
            numberOfNights?: number;
            /** Format: double */
            pricePerNight?: number;
            /** Format: double */
            totalPrice?: number;
            /** Format: double */
            taxAmount?: number | null;
            paymentMethod?: components["schemas"]["PaymentMethod"];
            status?: components["schemas"]["ReservationStatus"];
            source?: string | null;
            notes?: string | null;
            /** Format: date-time */
            createdAt?: string;
        };
        ReservationDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["ReservationDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        /**
         * Format: int32
         * @enum {integer}
         */
        ReservationEvent: 1 | 2 | 3;
        ReservationServiceLineDto: {
            /** Format: uuid */
            id?: string;
            /** Format: uuid */
            serviceId?: string;
            serviceName?: string | null;
            /** Format: double */
            price?: number;
            /** Format: int32 */
            quantity?: number;
            /** Format: double */
            totalPrice?: number;
            /** Format: date-time */
            serviceDate?: string;
            /** Format: time */
            startTime?: string | null;
            /** Format: time */
            endTime?: string | null;
            status?: components["schemas"]["ReservationStatus"];
        };
        /**
         * Format: int32
         * @enum {integer}
         */
        ReservationStatus: 1 | 2 | 3 | 4 | 5 | 6;
        ResetPasswordRequestDto: {
            email?: string | null;
            token?: string | null;
            newPassword?: string | null;
            confirmPassword?: string | null;
        };
        RevenueByRegionDto: {
            country?: string | null;
            city?: string | null;
            /** Format: int32 */
            hotelCount?: number;
            /** Format: double */
            totalRevenue?: number;
            /** Format: int32 */
            totalReservations?: number;
        };
        /** @description DTO for room availability response. */
        RoomAvailabilityDto: {
            /** @description Gets or sets a value indicating whether the room is available. */
            isAvailable?: boolean;
        };
        RoomAvailabilityDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["RoomAvailabilityDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        /** @description DTO for room count response. */
        RoomCountDto: {
            /**
             * Format: int32
             * @description Gets or sets the room count.
             */
            count?: number;
        };
        RoomCountDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["RoomCountDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        RoomDetailDto: {
            /** Format: uuid */
            id?: string;
            /** Format: uuid */
            hotelId?: string;
            number?: string | null;
            category?: string | null;
            /** Format: int32 */
            capacity?: number;
            /** Format: double */
            price?: number;
            status?: components["schemas"]["RoomStatus"];
            description?: string | null;
            amenities?: string | null;
            /** Format: int32 */
            floor?: number | null;
            includedServices?: components["schemas"]["RoomIncludedServiceDto"][] | null;
            /** Format: date-time */
            createdAt?: string;
            images?: components["schemas"]["RoomImageDto"][] | null;
        };
        RoomDetailDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["RoomDetailDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        RoomDto: {
            /** Format: uuid */
            id?: string;
            /** Format: uuid */
            hotelId?: string;
            number?: string | null;
            category?: string | null;
            /** Format: int32 */
            capacity?: number;
            /** Format: double */
            price?: number;
            status?: components["schemas"]["RoomStatus"];
            description?: string | null;
            amenities?: string | null;
            /** Format: int32 */
            floor?: number | null;
            includedServices?: components["schemas"]["RoomIncludedServiceDto"][] | null;
            /** Format: date-time */
            createdAt?: string;
        };
        RoomDtoApiListResponse: {
            readonly success?: boolean;
            readonly data?: components["schemas"]["RoomDto"][] | null;
            pagination?: components["schemas"]["PaginationMeta"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        RoomDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["RoomDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        RoomImageDto: {
            /** Format: uuid */
            id?: string;
            /** Format: uuid */
            roomId?: string;
            fileName?: string | null;
            contentType?: string | null;
            /** Format: int64 */
            fileSize?: number;
            /** Format: int32 */
            displayOrder?: number;
            isPrimary?: boolean;
            url?: string | null;
        };
        RoomImageDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["RoomImageDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        RoomImageDtoIReadOnlyListApiResponse: {
            readonly success?: boolean;
            readonly data?: components["schemas"]["RoomImageDto"][] | null;
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        RoomIncludedServiceDto: {
            /** Format: uuid */
            id?: string;
            /** Format: uuid */
            roomId?: string;
            /** Format: uuid */
            hotelServiceId?: string;
            serviceName?: string | null;
            /** Format: int32 */
            includedQuantity?: number;
            notes?: string | null;
            isActive?: boolean;
        };
        RoomIncludedServiceInputDto: {
            /** Format: uuid */
            hotelServiceId?: string;
            /** Format: int32 */
            includedQuantity?: number;
            notes?: string | null;
            isActive?: boolean;
        };
        RoomReservationDto: {
            /** Format: uuid */
            id?: string;
            reservationCode?: string | null;
            /** Format: uuid */
            hotelId?: string;
            hotelName?: string | null;
            /** Format: uuid */
            roomId?: string;
            roomNumber?: string | null;
            roomCategory?: string | null;
            /** Format: uuid */
            customerId?: string;
            customerName?: string | null;
            customerEmail?: string | null;
            /** Format: date-time */
            checkInDate?: string;
            /** Format: date-time */
            checkOutDate?: string;
            /** Format: int32 */
            numberOfGuests?: number;
            /** Format: int32 */
            numberOfNights?: number;
            /** Format: double */
            pricePerNight?: number;
            /** Format: double */
            totalPrice?: number;
            /** Format: double */
            taxAmount?: number | null;
            paymentMethod?: components["schemas"]["PaymentMethod"];
            status?: components["schemas"]["ReservationStatus"];
            specialRequests?: string | null;
            notes?: string | null;
            /** Format: double */
            servicesTotal?: number;
            /** Format: double */
            grandTotal?: number;
            services?: components["schemas"]["ReservationServiceLineDto"][] | null;
            /** Format: date-time */
            createdAt?: string;
        };
        RoomReservationDtoApiListResponse: {
            readonly success?: boolean;
            readonly data?: components["schemas"]["RoomReservationDto"][] | null;
            pagination?: components["schemas"]["PaginationMeta"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        RoomReservationDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["RoomReservationDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        /**
         * Format: int32
         * @enum {integer}
         */
        RoomStatus: 1 | 2 | 3 | 4 | 5;
        ServiceReservationDto: {
            /** Format: uuid */
            id?: string;
            /** Format: uuid */
            hotelId?: string;
            /** Format: uuid */
            customerId?: string;
            /** Format: uuid */
            serviceId?: string;
            serviceName?: string | null;
            /** Format: double */
            price?: number;
            /** Format: int32 */
            quantity?: number;
            /** Format: double */
            totalPrice?: number;
            /** Format: date-time */
            serviceDate?: string;
            /** Format: time */
            startTime?: string | null;
            /** Format: time */
            endTime?: string | null;
            notes?: string | null;
            /** Format: date-time */
            createdAt?: string;
        };
        ServiceReservationDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["ServiceReservationDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        ServiceReservationDtoIReadOnlyListApiResponse: {
            readonly success?: boolean;
            readonly data?: components["schemas"]["ServiceReservationDto"][] | null;
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        SetReceptionistActiveRequestDto: {
            isActive?: boolean;
        };
        SubscriptionDto: {
            /** Format: uuid */
            id?: string;
            name?: string | null;
            /** Format: double */
            price?: number;
            description?: string | null;
            /** Format: int32 */
            maxRooms?: number | null;
            /** Format: int32 */
            maxUsers?: number | null;
            isActive?: boolean;
            stripeProductId?: string | null;
            stripePriceId?: string | null;
            /** Format: int32 */
            trialPeriodDays?: number | null;
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            updatedAt?: string | null;
        };
        SubscriptionDtoApiListResponse: {
            readonly success?: boolean;
            readonly data?: components["schemas"]["SubscriptionDto"][] | null;
            pagination?: components["schemas"]["PaginationMeta"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        SubscriptionDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["SubscriptionDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        SubscriptionIntentResultDto: {
            /** Format: uuid */
            subscriptionHistoryId?: string;
            stripeSubscriptionId?: string | null;
            clientSecret?: string | null;
            isTrial?: boolean;
            /** Format: date-time */
            trialEndDate?: string | null;
            status?: components["schemas"]["SubscriptionStatus"];
            publishableKey?: string | null;
            checkoutUrl?: string | null;
            /** Format: uuid */
            paymentId?: string | null;
            stripeCheckoutSessionId?: string | null;
        };
        SubscriptionIntentResultDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["SubscriptionIntentResultDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        SubscriptionPlanDistributionDto: {
            /** Format: uuid */
            subscriptionId?: string;
            planName?: string | null;
            /** Format: int32 */
            hotelCount?: number;
            /** Format: double */
            percentage?: number;
            /** Format: double */
            monthlyRevenue?: number;
        };
        /**
         * Format: int32
         * @enum {integer}
         */
        SubscriptionStatus: 1 | 2 | 3 | 4 | 5 | 6 | 7;
        SubscriptionSummaryDto: {
            /** Format: uuid */
            id?: string;
            name?: string | null;
            /** Format: double */
            price?: number;
            isActive?: boolean;
            /** Format: int32 */
            maxRooms?: number | null;
            /** Format: int32 */
            maxUsers?: number | null;
        };
        /** @description DTO for trial eligibility check. */
        TrialEligibilityDto: {
            /** @description Gets or sets a value indicating whether the hotel is eligible for a trial. */
            isEligible?: boolean;
        };
        TrialEligibilityDtoApiResponse: {
            readonly success?: boolean;
            data?: components["schemas"]["TrialEligibilityDto"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        UpdateAdminSettingsDto: {
            emailNotifications?: boolean | null;
            pushNotifications?: boolean | null;
            weeklyReports?: boolean | null;
            securityAlerts?: boolean | null;
            twoFactorAuth?: boolean | null;
            /** Format: int32 */
            sessionTimeoutMinutes?: number | null;
            ipWhitelist?: string | null;
            autoBackup?: boolean | null;
            backupFrequency?: string | null;
            /** Format: int32 */
            dataRetentionDays?: number | null;
            defaultCurrency?: string | null;
            defaultLocale?: string | null;
            timezone?: string | null;
            /** Format: int32 */
            maxUsersPerHotel?: number | null;
            /** Format: int32 */
            maxRoomsPerHotel?: number | null;
            /** Format: int32 */
            trialDays?: number | null;
            smtpHost?: string | null;
            /** Format: int32 */
            smtpPort?: number | null;
            smtpUser?: string | null;
            smtpPassword?: string | null;
            smtpUseSsl?: boolean | null;
        };
        UpdateBrandingDto: {
            primaryColor?: string | null;
            logoUrl?: string | null;
            defaultLanguage?: string | null;
        };
        UpdateEmailTemplateDto: {
            event?: string | null;
            language?: string | null;
            subject?: string | null;
            bodyTemplate?: string | null;
        };
        UpdateHotelDto: {
            name?: string | null;
            category?: string | null;
            address?: string | null;
            city?: string | null;
            country?: string | null;
            postalCode?: string | null;
            /** Format: double */
            latitude?: number | null;
            /** Format: double */
            longitude?: number | null;
            phone?: string | null;
            email?: string | null;
            rcs?: string | null;
            nif?: string | null;
            stat?: string | null;
            currency?: string | null;
            locale?: string | null;
            description?: string | null;
            /** Format: uuid */
            subscriptionId?: string | null;
        };
        UpdateHotelServiceDto: {
            name?: string | null;
            /** Format: double */
            price?: number | null;
            unit?: string | null;
            description?: string | null;
            isActive?: boolean | null;
            /** Format: int32 */
            externalQuantity?: number | null;
            isExternallyBookable?: boolean | null;
        };
        UpdatePdfTemplateDto: {
            language?: string | null;
            contextualMentions?: string | null;
        };
        UpdateRoomDto: {
            number?: string | null;
            category?: string | null;
            /** Format: int32 */
            capacity?: number | null;
            /** Format: double */
            price?: number | null;
            status?: components["schemas"]["RoomStatus"];
            description?: string | null;
            amenities?: string | null;
            /** Format: int32 */
            floor?: number | null;
            includedServices?: components["schemas"]["RoomIncludedServiceInputDto"][] | null;
        };
        UpdateSubscriptionDto: {
            name?: string | null;
            /** Format: double */
            price?: number | null;
            description?: string | null;
            /** Format: int32 */
            maxRooms?: number | null;
            /** Format: int32 */
            maxUsers?: number | null;
            isActive?: boolean | null;
            /** Format: int32 */
            trialPeriodDays?: number | null;
        };
        UserDto: {
            /** Format: uuid */
            id?: string;
            firstName?: string | null;
            lastName?: string | null;
            email?: string | null;
            phone?: string | null;
            profilePicture?: string | null;
            role?: components["schemas"]["UserRole"];
            isActive?: boolean;
            /** Format: date-time */
            createdAt?: string;
            readonly fullName?: string | null;
        };
        UserDtoApiListResponse: {
            readonly success?: boolean;
            readonly data?: components["schemas"]["UserDto"][] | null;
            pagination?: components["schemas"]["PaginationMeta"];
            readonly message?: string | null;
            readonly errors?: string[] | null;
        };
        /**
         * Format: int32
         * @enum {integer}
         */
        UserRole: 1 | 2 | 3 | 4;
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
