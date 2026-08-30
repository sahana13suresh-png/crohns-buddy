# Requirements Document

## Introduction

This feature adds real user accounts to Crohn's Buddy and moves each patient's meal plans off the browser and into durable cloud storage, so a patient can sign in from any device and find their saved plans. It covers three areas:

1. **Accounts** — email/password signup and signin plus social (federated) signin, building on the partially implemented Firebase Authentication code already present in `src/lib/auth.ts`, `src/lib/firebase.ts`, and `src/components/AuthModal.tsx`. Google signin exists as an unused helper today and is not reachable from the UI.
2. **Cloud storage for meal plans** — persisting, listing, retrieving, and deleting AI-generated meal plans in an Amazon DynamoDB table, scoped per user with strict ownership isolation. Meal plans are currently not persisted at all; they exist only in React state for the duration of a session.
3. **Low-cost hosting** — cost and operational constraints that the design must satisfy when selecting a concrete deployment target, so the running site stays inexpensive at the expected small scale.

Because meal plans are derived from symptom, medication, allergy, and flare-status answers, the stored data is health-related personal data. Privacy, ownership isolation, data export, and account deletion are therefore in scope as first-class requirements rather than follow-up work.

Existing localStorage-based Symptom Tracker persistence (`src/lib/trackerStorage.ts`) remains the source of truth for tracker entries in this feature; only its inclusion in data export and account deletion is addressed here.

## Glossary

- **Website**: The Crohn's Buddy Next.js web application accessible via a browser
- **Patient**: A person using the Website who has Crohn's Disease or IBD
- **Account**: A persistent identity record for a Patient, identified by a User_Id
- **User_Id**: The immutable unique identifier assigned to an Account by the Auth_Service
- **Auth_Service**: The managed authentication provider that creates Accounts, verifies credentials, issues Auth_Tokens, and revokes sessions
- **Auth_Token**: The signed, time-limited credential issued by the Auth_Service that proves the identity of the Patient making a request
- **Identity_Provider**: An external service (for example Google or Apple) that authenticates a Patient on behalf of the Auth_Service
- **Auth_UI**: The signup and signin interface presented to the Patient, including the account modal and the header account controls
- **Session**: The period during which the Website treats a browser as acting on behalf of a specific Account
- **Meal_Plan**: A generated set of meals, food items, portions, summary text, and warnings, as produced by the Meal_Planner
- **Meal_Plan_Record**: A stored Meal_Plan together with its User_Id, Meal_Plan_Id, title, creation timestamp, and last-modified timestamp
- **Meal_Plan_Id**: The unique identifier of a Meal_Plan_Record within a single Account
- **Meal_Plan_Store**: The DynamoDB table and access layer that persists Meal_Plan_Records
- **Meal_Plan_API**: The server-side HTTP endpoints that create, list, read, and delete Meal_Plan_Records
- **Meal_Plan_Serializer**: The component that converts a Meal_Plan_Record into its stored DynamoDB item representation
- **Meal_Plan_Deserializer**: The component that converts a stored DynamoDB item representation back into a Meal_Plan_Record
- **Meal_Planner**: The existing quiz and AI chat feature that generates Meal_Plans
- **Account_Data_Export**: A single machine-readable document containing all data the Website holds for one Account
- **Account_Deletion_Flow**: The process that removes an Account and all data associated with its User_Id
- **Privacy_Notice**: The user-facing text describing what health-related data the Website stores, where it is stored, and how a Patient removes it
- **Hosting_Platform**: The service that serves the Website and runs its server-side request handlers in production
- **Deployment_Configuration**: The repository-committed configuration and documented settings that define how the Website is built, configured, and deployed to the Hosting_Platform
- **Monthly_Reference_Load**: A defined usage level of 1,000 monthly active Patients, 30,000 monthly page requests, 1,000 monthly Meal_Plan_Record writes, and 20,000 monthly Meal_Plan_Record reads

## Requirements

### Requirement 1: Email and Password Signup

**User Story:** As a patient, I want to create an account with my email address and a password, so that my meal plans are kept under an identity I control.

#### Acceptance Criteria

1. THE Auth_UI SHALL present a signup form that collects a display name of at most 50 characters, an email address of at most 254 characters, and a password of at most 128 characters, and SHALL mark all three fields as required
2. WHEN a Patient submits the signup form with a display name of 1 to 50 characters after leading and trailing whitespace is removed, an email address of at most 254 characters that contains exactly one "@" character with a non-empty local part and a domain part containing at least one "." character, and a password of 8 to 128 characters, THE Auth_Service SHALL create an Account, assign a User_Id, store the whitespace-trimmed display name on the Account, and start a Session for that Account within 10 seconds of submission
3. IF a Patient submits the signup form with a password shorter than 8 characters or longer than 128 characters, THEN THE Auth_UI SHALL display a message stating that the password requires 8 to 128 characters, SHALL leave the Account uncreated, and SHALL retain the display name and email address values already entered
4. IF a Patient submits the signup form with an email address that is already registered to an existing Account, THEN THE Auth_UI SHALL display a message stating that the email address is already registered and offering to sign in instead, SHALL leave the existing Account unchanged, and SHALL retain the display name and email address values already entered
5. IF a Patient submits the signup form with a display name that is empty or longer than 50 characters after leading and trailing whitespace is removed, THEN THE Auth_UI SHALL display a message stating that a display name of 1 to 50 characters is required, SHALL leave the Account uncreated, and SHALL display no other validation message unless another submitted value also fails validation
6. WHEN an Account is created through the signup form, THE Auth_Service SHALL send an email-address verification message to the submitted email address within 60 seconds of the Account being created
7. WHILE a Session belongs to an Account whose email address is unverified, THE Auth_UI SHALL display an indicator that the email address awaits verification and SHALL provide a control that resends the verification message at most once per 60 seconds for that Account, displaying a message stating when the next resend becomes available for a request made inside that interval
8. THE Auth_UI SHALL display a link to the Privacy_Notice within the signup form on the initial view of the form and after any validation message is displayed
9. IF a Patient submits the signup form with an email address that fails the email address format check stated in criterion 2, THEN THE Auth_UI SHALL display a message stating that a valid email address is required, SHALL leave the Account uncreated, and SHALL retain the display name value already entered
10. IF the Auth_Service does not complete Account creation within 10 seconds of submission, or reports a failure other than an already-registered email address, THEN THE Auth_UI SHALL display a message stating that account creation did not succeed and that the Patient may retry, SHALL leave the Account uncreated, SHALL retain the display name and email address values already entered, and SHALL clear the password field
11. WHEN the Auth_Service starts a Session following a signup form submission, THE Auth_UI SHALL close the account modal and SHALL display no validation message for that submission

### Requirement 2: Signin, Session Persistence, and Signout

**User Story:** As a returning patient, I want to sign in and stay signed in across visits, so that I reach my saved meal plans without re-entering credentials every time.

#### Acceptance Criteria

1. WHEN a Patient submits the signin form with an email address and password that match the stored credentials of an existing Account, THE Auth_Service SHALL start a Session for that Account, SHALL reset the recorded count of consecutive failed signin attempts for that email address to zero, and THE Auth_UI SHALL close the account modal
2. IF a Patient submits the signin form with an email address and password that match no existing Account, THEN THE Auth_UI SHALL display a single message stating that the email address or password is incorrect, SHALL indicate neither which of the two values is wrong nor whether the email address is registered, SHALL retain the value entered in the email field, and SHALL clear the password field
3. IF 10 consecutive signin attempts for the same email address fail within a 5 minute period, THEN THE Auth_Service SHALL reject every further signin attempt for that email address for the following 60 seconds and THE Auth_UI SHALL display a message stating that signin attempts are blocked and stating the number of seconds remaining before another attempt is accepted
4. WHILE a Session is active, THE Website SHALL display the display name of the signed-in Account and a signout control in the header of every page of the Website
5. WHEN a Patient reloads the Website in a browser that holds a Session whose 30 day validity has not elapsed, THE Website SHALL restore that Session and display the signed-in header within 3 seconds of page load without prompting for credentials
6. WHEN a Patient loads the Website in a browser that holds no Session, THE Auth_UI SHALL display the signin and signup controls and SHALL treat the visitor as unauthenticated until credentials are supplied
7. THE Auth_Service SHALL keep a Session valid for 30 days from the most recent successful authentication and SHALL end that Session when those 30 days elapse or when the Patient signs out
8. WHEN a Patient activates the signout control, THE Auth_Service SHALL end the Session, THE Website SHALL remove every Meal_Plan_Record from the browser view, and THE Website SHALL display the signin and signup controls within 3 seconds of activation, discarding the locally held Session even when the Auth_Service returns no response
9. WHEN a Patient submits the password reset control with a syntactically valid email address, THE Auth_Service SHALL send a password reset message to that email address within 5 minutes, SHALL send at most 3 password reset messages for the same email address within any 60 minute period, and THE Auth_UI SHALL display a confirmation stating that a reset message was sent if an Account exists for that address
10. WHEN a password reset is requested for an email address with no matching Account, THE Auth_UI SHALL display the same confirmation message it displays for a registered email address and THE Auth_Service SHALL send no message to that email address
11. IF a Patient submits the signin form with an empty email field, an empty password field, or an email address that is not syntactically valid, THEN THE Auth_UI SHALL display a message identifying the field requiring correction, SHALL send no signin request to the Auth_Service, and SHALL count no failed signin attempt against that email address
12. IF the Auth_Service returns no response within 10 seconds of a signin request, or returns a failure unrelated to the submitted credentials, THEN THE Auth_UI SHALL display a message stating that signin is temporarily unavailable, SHALL retain the value entered in the email field, SHALL leave the visitor unauthenticated, and SHALL count no failed signin attempt against that email address
13. WHEN a Patient loads the Website in a browser that holds a Session whose 30 day validity has elapsed, THE Website SHALL treat the visitor as unauthenticated, SHALL remove every Meal_Plan_Record from the browser view, and SHALL display a message stating that the Session expired together with the signin and signup controls

### Requirement 3: Social Signin

**User Story:** As a patient, I want to sign up and sign in with my existing Google account, so that I avoid creating and remembering another password.

#### Acceptance Criteria

1. WHERE Google is configured as an Identity_Provider in the Deployment_Configuration, THE Auth_UI SHALL present exactly one social signin control for Google on both the signin view and the signup view, and SHALL make that control operable by both pointer and keyboard
2. WHEN a Patient completes authentication with an Identity_Provider that returns an email address for which no Account exists, THE Auth_Service SHALL create exactly one Account for that email address, SHALL associate the Identity_Provider with that Account, and SHALL start a Session for that Account within 5 seconds of receiving the Identity_Provider response
3. WHEN the Auth_Service creates an Account from an Identity_Provider profile that supplies a display name of 1 or more characters after leading and trailing whitespace is removed, THE Auth_Service SHALL set the Account display name to the first 50 characters of that trimmed value
4. WHEN a Patient completes authentication with an Identity_Provider that returns an email address for which an Account already exists, matched without regard to letter case, THE Auth_Service SHALL start a Session for that existing Account within 5 seconds of receiving the Identity_Provider response, SHALL associate the Identity_Provider with that Account, SHALL leave the existing display name unchanged, and SHALL NOT create an additional Account
5. WHERE the Identity_Provider profile supplies no display name, or supplies a display name of 0 characters after leading and trailing whitespace is removed, THE Auth_Service SHALL set the Account display name to the first 50 characters of the local part of the email address returned by the Identity_Provider
6. IF a Patient closes or cancels the Identity_Provider authentication window before it completes, THEN THE Auth_UI SHALL return to the account modal within 2 seconds with no message describing an error, SHALL leave any existing Session unchanged, and SHALL leave every Account unchanged
7. IF the Identity_Provider returns an authentication failure, THEN THE Auth_UI SHALL display a message stating that signin with that provider did not succeed, SHALL keep the email and password fields enabled and accepting input, SHALL NOT start a Session, and SHALL leave every Account unchanged
8. IF the Identity_Provider completes authentication but returns no email address, THEN THE Auth_Service SHALL NOT create an Account and SHALL NOT start a Session, and THE Auth_UI SHALL display a message indicating that an email address is required to continue
9. IF the Identity_Provider authentication does not complete within 120 seconds of the Patient activating the social signin control, THEN THE Auth_UI SHALL stop waiting for the Identity_Provider, SHALL display a message indicating that the attempt timed out and can be retried, SHALL leave any existing Session unchanged, and SHALL leave every Account unchanged
10. THE Auth_UI SHALL display a social signin control for each Identity_Provider configured in the Deployment_Configuration, SHALL omit controls for Identity_Providers that are absent from the Deployment_Configuration, and SHALL keep the email and password fields available when the Deployment_Configuration contains zero Identity_Providers

### Requirement 4: Authenticated Access to Server Endpoints

**User Story:** As a patient, I want the server to confirm who I am on every request that touches my data, so that nobody can read or change my meal plans by guessing an identifier.

#### Acceptance Criteria

1. WHEN a request arrives at the Meal_Plan_API, THE Meal_Plan_API SHALL read the Auth_Token from the request, verify the token signature and expiry against the Auth_Service within 5 seconds, and derive the User_Id from the verified token before performing any read or write against the Meal_Plan_Store
2. IF a request to the Meal_Plan_API carries no Auth_Token, THEN THE Meal_Plan_API SHALL respond with HTTP status 401 and a message stating that authentication is required, and SHALL perform no read or write against the Meal_Plan_Store
3. IF a request to the Meal_Plan_API carries an Auth_Token that cannot be parsed, fails signature verification, or carries an expiry time more than 60 seconds in the past, THEN THE Meal_Plan_API SHALL respond with HTTP status 401 and a single message stating that the credential is not valid, SHALL include no detail identifying which of the three checks failed, and SHALL perform no read or write against the Meal_Plan_Store
4. THE Meal_Plan_API SHALL derive the User_Id used for every Meal_Plan_Store operation from the verified Auth_Token, SHALL ignore any User_Id value present in the request body, query string, or path, and SHALL complete the request against the derived User_Id without reporting an error when a supplied User_Id value differs from the derived User_Id
5. IF verification of an Auth_Token returns no result from the Auth_Service within 5 seconds across at most 2 attempts, THEN THE Meal_Plan_API SHALL respond with HTTP status 503 and a message stating that the service is temporarily unavailable, SHALL perform no read or write against the Meal_Plan_Store, and SHALL leave the Session unchanged so that a later request with the same Auth_Token can succeed
6. IF an Auth_Token passes signature and expiry verification but the Auth_Service reports the Account for the derived User_Id as removed or its Session as revoked, THEN THE Meal_Plan_API SHALL respond with HTTP status 401 and the same message it returns for an invalid credential, and SHALL perform no read or write against the Meal_Plan_Store
7. IF a request to the Meal_Plan_API carries an Auth_Token longer than 8,192 characters, THEN THE Meal_Plan_API SHALL respond with HTTP status 401, SHALL send no verification request to the Auth_Service, and SHALL perform no read or write against the Meal_Plan_Store

### Requirement 5: Saving Meal Plans to Cloud Storage

**User Story:** As a patient, I want to save a generated meal plan to my account, so that I can come back to it later from any device.

#### Acceptance Criteria

1. WHILE a Session is active, WHEN the Meal_Planner finishes generating and displaying a Meal_Plan, THE Meal_Planner SHALL display a save control within the displayed Meal_Plan view
2. WHILE a Session is active, WHEN a Patient activates the save control for a Meal_Plan that holds no Meal_Plan_Id, THE Meal_Plan_API SHALL assign a Meal_Plan_Id unique within that Account, write a Meal_Plan_Record containing the User_Id derived from the verified Auth_Token, the Meal_Plan content, a title, a creation timestamp, and a last-modified timestamp equal to the creation timestamp, and respond with the assigned Meal_Plan_Id within 5 seconds of receiving the request
3. WHEN a Patient activates the save control for a Meal_Plan that already holds a Meal_Plan_Id owned by the same Account, THE Meal_Plan_Store SHALL replace the stored Meal_Plan content, set the last-modified timestamp to the time the request is processed, preserve the Meal_Plan_Id and the creation timestamp, and create no additional Meal_Plan_Record
4. WHEN the Meal_Plan_API receives a save request identical to a save request it has already completed for the same Meal_Plan_Id and Account, THE Meal_Plan_Store SHALL hold exactly one Meal_Plan_Record for that Meal_Plan_Id whose Meal_Plan content, title, and creation timestamp equal the values stored after the first request
5. IF a save request carries no title or carries a title consisting only of whitespace characters, THEN THE Meal_Plan_API SHALL set the title to the creation date of the Meal_Plan_Record formatted as "Meal plan — YYYY-MM-DD"
6. THE Meal_Plan_API SHALL accept a supplied title of 1 to 100 characters measured after leading and trailing whitespace is removed
7. IF a save request carries a Meal_Plan whose serialized representation exceeds 100 kilobytes, THEN THE Meal_Plan_API SHALL respond with HTTP status 413 and a message stating that the meal plan is too large to save
8. THE Meal_Plan_Store SHALL hold at most 100 Meal_Plan_Records per Account
9. IF a save request would create a Meal_Plan_Record beyond the 100 record limit for that Account, THEN THE Meal_Plan_API SHALL respond with HTTP status 409 and a message stating that the Patient must delete an existing saved meal plan before saving another
10. WHEN a save request succeeds, THE Meal_Planner SHALL display within 2 seconds of receiving the response a confirmation stating that the Meal_Plan is saved to the Account
11. IF a save request returns a failure or receives no response within 10 seconds, THEN THE Meal_Planner SHALL display a message stating that saving did not succeed, SHALL retain the generated Meal_Plan unchanged in the current view, and SHALL display a control that resubmits the same save request
12. WHILE no Session is active, THE Meal_Planner SHALL generate and display Meal_Plans, SHALL display no save control, and SHALL display a message stating that saving a meal plan requires an account
13. WHEN the Meal_Plan_API responds to a save request with an assigned Meal_Plan_Id, THE Meal_Planner SHALL retain that Meal_Plan_Id with the displayed Meal_Plan so that a subsequent activation of the save control updates the same Meal_Plan_Record instead of creating another Meal_Plan_Record
14. IF a save request supplies a title longer than 100 characters, THEN THE Meal_Plan_API SHALL store the first 100 characters of that title and SHALL complete the save
15. IF a save request carries a Meal_Plan that contains no meals, THEN THE Meal_Plan_API SHALL reject the request with an error response indicating that the meal plan contains no meals and SHALL write no Meal_Plan_Record

### Requirement 6: Listing and Retrieving Saved Meal Plans

**User Story:** As a patient, I want to browse the meal plans I have saved and reopen one, so that I can reuse a plan that worked well for me.

#### Acceptance Criteria

1. WHILE a Session is active, WHEN a Patient opens the saved meal plans view, THE Meal_Planner SHALL request the first page of Meal_Plan_Records belonging to the signed-in Account, SHALL display a progress indicator while that request is in flight, and SHALL display for each returned record its stored title of up to 100 characters and its creation date formatted as YYYY-MM-DD
2. THE Meal_Plan_API SHALL return listed Meal_Plan_Records ordered by creation timestamp with the most recently created record first, and SHALL order records sharing an identical creation timestamp by Meal_Plan_Id so that repeated list requests for an unchanged Account return the same order
3. WHEN a list request would return more than 20 Meal_Plan_Records, THE Meal_Plan_API SHALL return the first 20 records together with a continuation token, and THE Meal_Planner SHALL provide a control that requests the next 20 records and appends the returned records below the records already displayed
4. WHEN a Patient selects a Meal_Plan_Record from the list, THE Meal_Planner SHALL read that record and display the stored Meal_Plan using the same meal, item, portion, summary, and warning layout used for a newly generated Meal_Plan, preserving the stored order of meals, items, and warnings
5. WHILE a Session is active and the signed-in Account owns no Meal_Plan_Records, THE Meal_Planner SHALL display a message stating that no saved meal plans exist yet and SHALL display no list rows
6. IF a list or read request fails because the Meal_Plan_Store is unavailable, or does not complete within 10 seconds, THEN THE Meal_Planner SHALL display a message stating that saved meal plans are temporarily unreachable, SHALL keep any previously displayed Meal_Plan_Records visible, and SHALL offer a control that retries the request
7. WHEN a Patient reopens a stored Meal_Plan, THE Meal_Planner SHALL supply the content of that Meal_Plan as the plan context for every subsequent AI chat message in the Session and SHALL stop supplying the previously displayed Meal_Plan as that context
8. WHEN the Meal_Plan_API returns the final page of Meal_Plan_Records for an Account, THE Meal_Plan_API SHALL omit the continuation token and THE Meal_Planner SHALL remove the control that requests further records
9. IF the Meal_Plan_Deserializer signals an error for a selected Meal_Plan_Record, THEN THE Meal_Planner SHALL display a message stating that the saved meal plan cannot be opened, SHALL keep the saved meal plans list displayed, and SHALL leave the stored Meal_Plan_Record unchanged
10. WHILE no Session is active, THE Meal_Planner SHALL display no Meal_Plan_Records and SHALL display a message stating that viewing saved meal plans requires signing in

### Requirement 7: Ownership Isolation

**User Story:** As a patient, I want my health-related meal plans visible only to me, so that my condition details stay private.

#### Acceptance Criteria

1. THE Meal_Plan_Store SHALL store the User_Id of the owning Account as the partition key of every Meal_Plan_Record and the Meal_Plan_Id as the sort key, so that no Meal_Plan_Record is stored without an owning User_Id
2. WHEN the Meal_Plan_API reads Meal_Plan_Records, THE Meal_Plan_Store SHALL restrict the read to Meal_Plan_Records whose stored User_Id equals the User_Id derived from the verified Auth_Token, SHALL return zero Meal_Plan_Records stored under any other User_Id, and SHALL perform no operation that reads across more than one User_Id
3. IF a request references a Meal_Plan_Id that exists under a User_Id other than the User_Id derived from the verified Auth_Token, THEN THE Meal_Plan_API SHALL respond with HTTP status 404 and a message stating that the meal plan was not found, SHALL leave that Meal_Plan_Record unchanged, and SHALL exclude the title, content, timestamps, and owner identity of that record from the response
4. IF a request references a Meal_Plan_Id that exists under no Account, THEN THE Meal_Plan_API SHALL respond with the same HTTP status, the same message, and the same set of response fields it returns for a Meal_Plan_Id owned by a different Account
5. THE Meal_Plan_Store credentials SHALL permit read and write operations only against the Meal_Plan_Store, SHALL be readable only by the server-side request handlers of the Meal_Plan_API, and SHALL be absent from every asset the Website delivers to the browser
6. THE Meal_Plan_API SHALL limit each log entry for a Meal_Plan_Store operation to the Meal_Plan_Id, the operation name, the outcome recorded as success or as failure with a failure category, and the operation timestamp, and SHALL exclude Meal_Plan content, quiz answers, email addresses, display names, and Auth_Token values from log output
7. WHEN the Meal_Plan_API writes, updates, or deletes a Meal_Plan_Record, THE Meal_Plan_Store SHALL apply the operation only to Meal_Plan_Records whose stored User_Id equals the User_Id derived from the verified Auth_Token and SHALL leave Meal_Plan_Records stored under every other User_Id unchanged
8. IF a request supplies a Meal_Plan_Id that is empty, longer than 64 characters, or contains characters other than letters, digits, and hyphens, THEN THE Meal_Plan_API SHALL respond with the same HTTP status and message it returns for a Meal_Plan_Id owned by a different Account and SHALL perform no read or write against the Meal_Plan_Store

### Requirement 8: Deleting and Renaming Saved Meal Plans

**User Story:** As a patient, I want to rename and delete saved meal plans, so that my list stays useful and I can remove plans I no longer want stored.

#### Acceptance Criteria

1. WHEN a Patient confirms deletion of a Meal_Plan_Record whose owner matches the signed-in Account, THE Meal_Plan_Store SHALL remove that Meal_Plan_Record within 5 seconds and THE Meal_Planner SHALL remove the record from the displayed list within 1 second of receiving the successful delete response, leaving the remaining Meal_Plan_Records in their existing order
2. WHEN a Patient requests deletion of a Meal_Plan_Record, THE Meal_Planner SHALL display a confirmation prompt that identifies the Meal_Plan_Record by its title and offers exactly one confirm control and one cancel control, and SHALL NOT send the delete request until the confirm control is activated
3. WHEN a delete request references a Meal_Plan_Id that the Meal_Plan_Store no longer holds for that Account, THE Meal_Plan_API SHALL respond with HTTP status 204 and SHALL leave all other Meal_Plan_Records for that Account unchanged
4. WHEN a Patient submits a new title that is 1 to 100 characters long after removal of leading and trailing whitespace for a Meal_Plan_Record whose owner matches the signed-in Account, THE Meal_Plan_Store SHALL store the whitespace-trimmed title, SHALL set the last-modified timestamp to the time the rename was stored, and SHALL preserve the Meal_Plan content unchanged
5. IF a delete request fails because the Meal_Plan_Store is unavailable or returns no response within 10 seconds, THEN THE Meal_Planner SHALL display an error message indicating that the deletion did not succeed, SHALL keep the Meal_Plan_Record visible in the list, and SHALL keep the delete control available for another attempt
6. IF a Patient submits a new title that is empty after removal of leading and trailing whitespace or that exceeds 100 characters, THEN THE Meal_Planner SHALL reject the rename without sending a rename request, SHALL display an error message indicating that the title must be 1 to 100 characters, and SHALL retain the currently stored title in the displayed list
7. IF a delete or rename request references a Meal_Plan_Record whose owner does not match the signed-in Account, THEN THE Meal_Plan_API SHALL reject the request without modifying or removing any Meal_Plan_Record and THE Meal_Planner SHALL display an error message indicating that the requested plan is not available to that Account
8. IF a rename request fails because the Meal_Plan_Store is unavailable or returns no response within 10 seconds, THEN THE Meal_Planner SHALL display an error message indicating that the rename did not succeed and SHALL restore the previously stored title in the displayed list

### Requirement 9: Meal Plan Record Serialization

**User Story:** As a patient, I want a reopened meal plan to show exactly what was generated, so that I can trust the plan I follow.

#### Acceptance Criteria

1. WHEN the Meal_Plan_Serializer is invoked with a valid Meal_Plan_Record, THE Meal_Plan_Serializer SHALL produce a DynamoDB item representation that retains the User_Id, Meal_Plan_Id, title, creation timestamp, last-modified timestamp, every meal name, every item name, every portion, every item note, the summary text, and every warning, with all string values byte-for-byte identical to the source values and both timestamps retained as UTC values with millisecond precision
2. WHEN the Meal_Plan_Deserializer is invoked with a DynamoDB item representation produced by the Meal_Plan_Serializer, THE Meal_Plan_Deserializer SHALL produce a Meal_Plan_Record populated with every attribute listed in criterion 1
3. WHEN the Meal_Plan_Serializer is applied to a valid Meal_Plan_Record and the Meal_Plan_Deserializer is then applied to the resulting item, THE Meal_Plan_Deserializer SHALL produce a Meal_Plan_Record whose field values, meal sequence, item sequence within each meal, and warning sequence are identical to those of the original record
4. WHERE a Meal_Plan item carries no notes value or a Meal_Plan carries no warnings value, WHEN the Meal_Plan_Serializer is invoked, THE Meal_Plan_Serializer SHALL omit the corresponding attributes from the produced item, and WHEN the Meal_Plan_Deserializer reads that item, THE Meal_Plan_Deserializer SHALL produce a Meal_Plan_Record in which those values are absent rather than set to an empty value
5. IF the Meal_Plan_Deserializer reads an item in which any of the attributes listed in criterion 1 other than item notes and warnings is absent, or in which any attribute holds a value of a type other than the type written by the Meal_Plan_Serializer, THEN THE Meal_Plan_Deserializer SHALL signal an error that names the attribute at fault, SHALL NOT return a partially populated Meal_Plan_Record, and SHALL leave the stored item unmodified
6. WHEN the Meal_Plan_Serializer and then the Meal_Plan_Deserializer are applied to a Meal_Plan_Record whose meal names, item names, portions, notes, summary text, or warnings contain non-ASCII characters, newline characters, or single or double quotation marks, THE Meal_Plan_Deserializer SHALL produce values in which those characters are present in the same positions and counts as in the original record, with no escape sequences introduced or removed
7. THE Meal_Plan_Serializer SHALL treat a Meal_Plan_Record as valid only when it contains 1 to 10 meals, each meal contains 1 to 20 items, the record contains 0 to 20 warnings, the title is 1 to 200 characters, each meal name is 1 to 100 characters, each item name is 1 to 200 characters, each portion is 1 to 100 characters, each item note is 0 to 1,000 characters, the summary text is 0 to 5,000 characters, and each warning is 1 to 500 characters
8. IF the Meal_Plan_Serializer is invoked with a Meal_Plan_Record that violates any bound stated in criterion 7, THEN THE Meal_Plan_Serializer SHALL signal an error that names the field or collection that violates the bound and SHALL NOT produce a DynamoDB item representation
9. WHEN the Meal_Plan_Serializer and then the Meal_Plan_Deserializer are applied to a Meal_Plan_Record that carries zero warnings and whose meals carry no notes, THE Meal_Plan_Deserializer SHALL produce a Meal_Plan_Record equal to the original record without signalling an error

### Requirement 10: Data Export

**User Story:** As a patient, I want to download everything the site stores about me, so that I keep a copy of my own health data.

#### Acceptance Criteria

1. WHILE a Session is active, THE Website SHALL display in the account settings view a control that requests an Account_Data_Export for the signed-in Account
2. WHEN a Patient requests an Account_Data_Export, THE Website SHALL produce a single JSON document containing the User_Id, display name, email address, Account creation date, every Meal_Plan_Record owned by the Account up to the 100 record per Account limit, and every Symptom Tracker entry held in the browser for that device, and SHALL apply no page size limit to the Meal_Plan_Records included
3. WHERE the Account owns no Meal_Plan_Records or the browser holds no Symptom Tracker entries for that device, THE Account_Data_Export SHALL contain an empty collection for the absent data rather than omitting it
4. WHEN an Account_Data_Export is produced, THE Website SHALL deliver the document to the Patient as a single file download named `crohns-buddy-export-YYYY-MM-DD.json`, where YYYY-MM-DD is the UTC date on which the document was produced
5. THE Account_Data_Export SHALL contain data belonging only to the Account whose Auth_Token was verified for the request
6. THE Account_Data_Export SHALL exclude password values, Auth_Tokens, and Identity_Provider credentials
7. WHEN a Patient requests an Account_Data_Export for an Account owning at most 100 Meal_Plan_Records, THE Website SHALL deliver the file download within 10 seconds of the request
8. IF a request for an Account_Data_Export carries no verifiable Auth_Token, THEN THE Website SHALL produce no Account_Data_Export, SHALL read no Meal_Plan_Record, and SHALL display the signin controls
9. IF an Account_Data_Export request fails because the Meal_Plan_Store is unreachable, because Auth_Token verification does not succeed, or because the document is not delivered within 10 seconds, THEN THE Website SHALL display a message stating that the export did not complete, SHALL deliver no partial file, SHALL leave every Meal_Plan_Record and Symptom Tracker entry unchanged, and SHALL offer a control that retries the request

### Requirement 11: Account Deletion

**User Story:** As a patient, I want to delete my account and all its data, so that my health information stops being stored when I no longer want the service.

#### Acceptance Criteria

1. WHILE a Session is active, THE Website SHALL provide a control in the account settings view that starts the Account_Deletion_Flow
2. WHEN a Patient starts the Account_Deletion_Flow, THE Website SHALL list the data categories to be removed, comprising the Account identity, every Meal_Plan_Record owned by the Account, and the Symptom Tracker entries held in the browser on the current device, SHALL state that the removal cannot be undone, SHALL display the Account_Data_Export control, and SHALL keep the confirm control disabled until the Patient types the exact uppercase text "DELETE" into the confirmation field
3. WHEN a Patient confirms the Account_Deletion_Flow and the re-authentication requirement is satisfied, THE Account_Deletion_Flow SHALL remove every Meal_Plan_Record whose User_Id matches the signed-in Account, then remove the Account from the Auth_Service, then clear the Symptom Tracker entries held in the browser on the current device, then end the Session, and SHALL complete these steps within 30 seconds
4. WHEN the Account_Deletion_Flow completes, THE Website SHALL display within 5 seconds a confirmation stating that the Account, its stored Meal_Plan_Records, and the Symptom Tracker entries on the current device are removed, and SHALL display the signin and signup controls
5. IF a Patient confirms the Account_Deletion_Flow when the most recent successful authentication of the Session occurred more than 5 minutes earlier, THEN THE Auth_Service SHALL prompt the Patient to re-authenticate and THE Account_Deletion_Flow SHALL remove no data until that re-authentication succeeds
6. IF the Session expires while the Account_Deletion_Flow is in progress, THEN THE Account_Deletion_Flow SHALL remove no data, SHALL prompt the Patient to re-authenticate, and SHALL resume at the confirmation step requiring the Patient to type the confirmation text again after re-authentication succeeds
7. IF the Account_Deletion_Flow removes the Account from the Auth_Service and one or more Meal_Plan_Record deletions then fail, THEN THE Account_Deletion_Flow SHALL retry the failed deletions up to 3 times within 60 seconds, SHALL record the User_Id in a pending-deletion list when a deletion still fails after those retries, SHALL retry the recorded deletions at least once every 24 hours until no Meal_Plan_Record for that User_Id remains, and SHALL display a message stating that the Account is removed and that removal of the remaining meal plan data is still in progress
8. IF a Patient submits the confirmation field with text that does not match the uppercase text "DELETE" exactly, THEN THE Website SHALL display a message stating that the confirmation text must match exactly, SHALL remove no data, and SHALL keep the Account_Deletion_Flow open with the confirmation field editable
9. IF a Meal_Plan_Record deletion fails before the Account is removed from the Auth_Service, THEN THE Account_Deletion_Flow SHALL stop, SHALL leave the Account and every remaining Meal_Plan_Record intact, SHALL keep the Session active, SHALL display a message stating that the deletion did not complete, and SHALL offer a control that restarts the Account_Deletion_Flow
10. IF the Patient cancels the re-authentication prompt or re-authentication fails on 3 consecutive attempts, THEN THE Account_Deletion_Flow SHALL end, SHALL remove no data, and SHALL display a message stating that the Account was not deleted

### Requirement 12: Privacy and Health Data Handling

**User Story:** As a patient, I want to understand what health data leaves my browser and where it goes, so that I can decide whether to save my plans.

#### Acceptance Criteria

1. THE Privacy_Notice SHALL state that saved Meal_Plan_Records derive from health-related quiz answers covering symptoms, medications, allergies, and flare status, SHALL name the cloud region where Meal_Plan_Records are stored, SHALL state that Meal_Plan_Records are retained until the Patient deletes them or completes the Account_Deletion_Flow, and SHALL state how a Patient reaches the Account_Data_Export control and the Account_Deletion_Flow control
2. THE Website SHALL present a link to the Privacy_Notice within the signup form, within the signin form, and within the account settings view, and SHALL make the Privacy_Notice readable while no Session is active
3. WHEN a Patient activates the save control for a Meal_Plan on an Account that holds no recorded acknowledgment of the storage notice, THE Website SHALL display a notice stating that health-related meal plan data will be stored in the cloud under that Account and naming the cloud region where Meal_Plan_Records are stored, and THE Meal_Plan_API SHALL write the Meal_Plan_Record only after the Patient activates the acknowledgment control in that notice
4. WHEN a Patient activates the acknowledgment control in the storage notice, THE Website SHALL record the acknowledgment against the User_Id of that Account and SHALL omit the storage notice from every subsequent save request for that Account
5. IF a Patient closes or declines the storage notice without activating the acknowledgment control, THEN THE Meal_Plan_API SHALL write no Meal_Plan_Record, THE Meal_Planner SHALL retain the generated Meal_Plan in the current view, and THE Website SHALL display a message stating that saving requires acknowledging the storage notice
6. THE Meal_Plan_Store SHALL keep Meal_Plan_Records encrypted at rest
7. THE Website SHALL serve every page and every Meal_Plan_API endpoint over HTTPS
8. IF a request for a page or a Meal_Plan_API endpoint arrives over unencrypted HTTP, THEN THE Website SHALL redirect the request to the HTTPS address of the same resource and SHALL perform no read or write against the Meal_Plan_Store
9. WHEN the Website sends a payload to a third-party analytics service or a third-party error-reporting service, THE Website SHALL exclude Meal_Plan content, quiz answers, email addresses, and display names from that payload
10. THE Privacy_Notice SHALL state that the Website provides no medical advice and that Patients should consult a clinician before changing their diet

### Requirement 13: Low-Cost Hosting and Operating Cost

**User Story:** As the site owner, I want the site to run on cheap, low-maintenance infrastructure, so that keeping Crohn's Buddy online stays affordable for a small volunteer project.

#### Acceptance Criteria

1. THE Hosting_Platform SHALL serve the Website at the Monthly_Reference_Load for a total recurring infrastructure cost of no more than 10.00 US dollars for any single calendar month, measured from the Hosting_Platform and Meal_Plan_Store billing statements for that month, excluding AI inference charges and domain registration
2. WHILE no request has been received by the Website for 15 consecutive minutes, THE Hosting_Platform SHALL hold zero running compute instances for the server-side request handlers of the Website, so that the compute charge accrued for that idle interval is 0.00 US dollars
3. THE Meal_Plan_Store SHALL use on-demand capacity billing with no minimum provisioned-capacity charge, so that a calendar month with zero stored Meal_Plan_Records and zero read or write requests incurs a Meal_Plan_Store charge of 0.00 US dollars, and so that charges otherwise scale with the number of stored Meal_Plan_Records and the number of requests
4. THE Hosting_Platform SHALL provide a TLS certificate for the Website domain, and SHALL renew that certificate no later than 15 days before its expiry date, at an additional charge of 0.00 US dollars
5. WHEN a commit is pushed to the repository default branch, THE Deployment_Configuration SHALL build and publish the Website to the Hosting_Platform within 15 minutes, with zero manual server provisioning steps required from the site owner
6. THE Deployment_Configuration SHALL place the Meal_Plan_Store in the same cloud region as the AI inference endpoint used by the Meal_Planner, so that the cross-region data transfer charge for Meal_Planner traffic is 0.00 US dollars
7. THE Deployment_Configuration SHALL supply the Auth_Service credentials, the AI inference credentials, and the Meal_Plan_Store credentials to the Website through platform-managed environment configuration, and no file tracked in the repository SHALL contain any of those credential values
8. IF the month-to-date infrastructure cost recorded by the Hosting_Platform reaches 20.00 US dollars, THEN THE Deployment_Configuration spend alert SHALL send a notification to the site owner contact address recorded in the Deployment_Configuration within 24 hours of the threshold being reached, without waiting for the monthly bill to finalize
9. THE Deployment_Configuration SHALL document, in a location tracked in the repository, the name of the chosen Hosting_Platform, the monthly cost estimate in US dollars at the Monthly_Reference_Load, and each free-tier allowance that estimate depends on together with that allowance's quantity limit
10. WHERE the Hosting_Platform restricts its lowest-cost plan to non-commercial use, THE Deployment_Configuration SHALL record that restriction alongside the cost estimate, together with a statement of whether the Website's intended use falls inside that restriction
11. IF any of the Auth_Service credentials, the AI inference credentials, or the Meal_Plan_Store credentials are absent from the platform-managed environment configuration at Website startup, THEN THE Website SHALL fail startup and SHALL emit a startup error indicating which credential group is missing, without substituting a default or placeholder credential value
12. IF a build or publish triggered by a default-branch commit fails, THEN THE Deployment_Configuration SHALL keep the previously published version of the Website serving requests, and SHALL notify the site owner contact address recorded in the Deployment_Configuration within 24 hours with an indication that the deployment failed
13. WHEN a request arrives at the Website after an idle interval during which zero compute instances were running, THE Hosting_Platform SHALL return the first response within 10 seconds
