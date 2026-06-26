# Implementation Plan: Crohn's Buddy Website

## Overview

Build a single-page Next.js 14 application with five tabbed sections for Crohn's Disease patients. The implementation proceeds from project scaffolding and shared utilities, through static content pages, to interactive features (symptom tracker, AI meal planner, community chat forum). Each phase builds incrementally on previous work and wires components together at the end.

## Tasks

- [x] 1. Set up project structure, theme, and shared utilities
  - [x] 1.1 Initialize Next.js 14 project with TypeScript, Tailwind CSS, and configure the blue color theme
    - Create the Next.js 14 app with App Router
    - Configure `tailwind.config.ts` with custom blue palette from `src/lib/theme.ts`
    - Set up global styles with the blue theme applied to body, headings, and links
    - Add the Crohn's Buddy logo asset to the public directory
    - _Requirements: 1.1, 1.2_

  - [x] 1.2 Create shared utility modules and type definitions
    - Create `src/lib/theme.ts` with blue color palette constants
    - Create `src/lib/trackerStorage.ts` with read/write functions for localStorage (TrackerEntry interface, keyed by date)
    - Create `src/lib/quizConfig.ts` with question definitions for all 6 quiz sections
    - Create `src/lib/firebase.ts` with Firebase initialization and Firestore helpers
    - Define all TypeScript interfaces (TrackerEntry, Section1-6Answers, ForumMessage, MealPlanRequest/Response, ChatRequest/Response, ModerateRequest/Response)
    - _Requirements: 4.7, 5.3, 8.2_

  - [x] 1.3 Set up testing framework with Vitest, React Testing Library, and fast-check
    - Install and configure Vitest with React Testing Library
    - Install fast-check for property-based testing
    - Create test setup file with jsdom environment
    - Add test scripts to package.json
    - _Requirements: (testing infrastructure)_

- [x] 2. Implement tab navigation and page layout
  - [x] 2.1 Build the TabNavigation component with keyboard accessibility
    - Create `src/components/TabNavigation.tsx` with 5 tabs in order: "Welcome", "About Crohn's", "Symptom Tracker", "AI Meal Planner", "Resources"
    - Implement active tab visual distinction with 3:1 contrast ratio
    - Implement keyboard navigation (Enter/Space to activate, arrow keys to move focus)
    - Set "Welcome" as the default active tab on initial load
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.7_

  - [x] 2.2 Create the main page layout with header, logo, and tab content switching
    - Create `src/app/page.tsx` as the main page that renders the header with logo, TabNavigation, and conditionally renders page components based on active tab
    - Ensure tab switching occurs without full page reload (client-side state)
    - _Requirements: 1.1, 1.4, 1.6_

  - [ ]* 2.3 Write property test for tab navigation (Property 1)
    - **Property 1: Tab Navigation Displays Correct Page**
    - Generate random tab identifiers from the set of 5 tabs → verify correct page component is rendered and others are hidden
    - **Validates: Requirements 1.4**

- [x] 3. Implement static content pages (Welcome, About, Resources)
  - [x] 3.1 Build the WelcomePage component
    - Create `src/components/pages/WelcomePage.tsx`
    - Add introductory section explaining mission of Crohn's Buddy
    - Add "Meet the Team" section with Sahana Suresh (Founder and Crohn's Patient) and Annabelle Koo (Marketing and Outreach)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.2 Build the AboutPage component
    - Create `src/components/pages/AboutPage.tsx`
    - Add sections: What is Crohn's Disease, What is IBD, Common Symptoms, Causes and Risk Factors, Treatment Approaches
    - Ensure all sections have visible headings (minimum 4 distinct labeled sections)
    - Present as static informational text requiring no user interaction
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x] 3.3 Build the ResourcesPage component with external links
    - Create `src/components/pages/ResourcesPage.tsx`
    - Add curated list of external links relevant to Crohn's Disease patients
    - Include teen-specific resources and Camp Oasis link
    - Ensure all external links open in new tab with `target="_blank"` and `rel="noopener noreferrer"`
    - Reserve space at bottom for Chat Forum component (to be wired in later)
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 4. Checkpoint - Verify static pages and navigation
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement Symptom Tracker
  - [x] 5.1 Build the Calendar component
    - Create `src/components/tracker/Calendar.tsx`
    - Display days of current month in a grid layout
    - Visually distinguish days with saved TrackerEntry from empty days
    - Handle day selection — allow only today or past dates to trigger form display
    - Show indicator for future dates that entries cannot be logged
    - _Requirements: 4.1, 4.2, 4.10_

  - [x] 5.2 Build the TrackerForm component
    - Create `src/components/tracker/TrackerForm.tsx`
    - Add food consumed free-text field (max 500 characters)
    - Add pain level numeric input (1-10 scale)
    - Add bowel movements numeric input (0-20)
    - Add stress level input (1-10 scale) and energy level input (1-10 scale)
    - Implement client-side validation for all field constraints
    - Present as single-page form with one submission action
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 4.9_

  - [x] 5.3 Build the SymptomTrackerPage and wire localStorage persistence
    - Create `src/components/pages/SymptomTrackerPage.tsx`
    - Wire Calendar and TrackerForm together
    - Save entries to localStorage on submit via `trackerStorage` utility
    - Load existing entries for selected date and populate form for editing
    - _Requirements: 4.7, 4.8_

  - [ ]* 5.4 Write property test for date-based form visibility (Property 2)
    - **Property 2: Date-Based Form Visibility**
    - Generate random dates (past, today, future) → verify form is shown only for today or past
    - **Validates: Requirements 4.2, 4.10**

  - [ ]* 5.5 Write property test for tracker entry field validation (Property 3)
    - **Property 3: Tracker Entry Field Validation**
    - Generate random field values (in-range and out-of-range) → verify validation accepts/rejects correctly
    - **Validates: Requirements 4.3, 4.4, 4.5**

  - [ ]* 5.6 Write property test for tracker entry persistence round trip (Property 4)
    - **Property 4: Tracker Entry Persistence Round Trip**
    - Generate random valid tracker entries → save to localStorage mock → read back → verify equality
    - **Validates: Requirements 4.7, 4.8**

- [x] 6. Implement AI Meal Planner Quiz
  - [x] 6.1 Build the QuizFlow and QuizSection components with progress indicator
    - Create `src/components/planner/QuizFlow.tsx` managing section navigation and progress
    - Create `src/components/planner/QuizSection.tsx` rendering questions for one section
    - Implement progress indicator showing current section and total remaining
    - Allow navigation back to previously completed sections for review/editing
    - _Requirements: 5.3, 5.12_

  - [x] 6.2 Implement quiz section content and validation
    - Render all 24 questions across 6 sections using `quizConfig.ts` definitions
    - Implement per-section validation that blocks advancement if any question is unanswered
    - Show inline indication identifying unanswered questions
    - Add disclaimer at top visible without scrolling
    - _Requirements: 5.1, 5.2, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.11_

  - [x] 6.3 Implement quiz answer compilation into structured prompt
    - On final section completion, compile all answers into a structured prompt organized by section name and question
    - Ensure every individual answer is included with no omissions or duplicates
    - _Requirements: 5.10_

  - [ ]* 6.4 Write property test for quiz section validation (Property 6)
    - **Property 6: Quiz Section Validation Prevents Incomplete Advancement**
    - Generate quiz sections with random missing answers → verify advancement is blocked and unanswered questions identified
    - **Validates: Requirements 5.11**

  - [ ]* 6.5 Write property test for quiz prompt compilation (Property 5)
    - **Property 5: Quiz Prompt Compilation Completeness**
    - Generate random complete quiz answer sets → compile prompt → verify all answers present in output
    - **Validates: Requirements 5.10**

- [x] 7. Implement AI Meal Plan Generation and Chat
  - [x] 7.1 Create the /api/meal-plan API route
    - Create `src/app/api/meal-plan/route.ts`
    - Accept POST with structured quiz answers
    - Build system prompt and user context from answers
    - Call OpenAI API (GPT-4o-mini) with 60-second timeout
    - Return structured meal plan response with meals, items, and portions
    - Handle errors (timeout, rate limit, server error, malformed response)
    - _Requirements: 6.1, 6.6_

  - [x] 7.2 Create the /api/chat API route
    - Create `src/app/api/chat/route.ts`
    - Accept POST with message, conversation history, and current meal plan
    - Call OpenAI API with context of existing meal plan and history
    - Return AI reply referencing current meal plan
    - Handle errors with appropriate messages
    - _Requirements: 6.4, 6.6_

  - [x] 7.3 Build the MealPlanDisplay component
    - Create `src/components/planner/MealPlanDisplay.tsx`
    - Render meal plan with labeled sections for each meal
    - Display food items with portion descriptions per meal
    - Show loading indicator during generation
    - Show error messages with retry button on failure
    - _Requirements: 6.1, 6.2, 6.6_

  - [x] 7.4 Build the AIChatInterface component
    - Create `src/components/planner/AIChatInterface.tsx`
    - Render conversation UI below/adjacent to meal plan
    - Maintain conversation history in client state for session duration
    - Send messages to /api/chat with full history context
    - Display AI responses and handle loading/error states
    - _Requirements: 6.3, 6.4, 6.5, 6.6_

  - [x] 7.5 Build the MealPlannerPage and wire quiz to AI generation
    - Create `src/components/pages/MealPlannerPage.tsx`
    - Connect QuizFlow completion to /api/meal-plan call
    - Display MealPlanDisplay on successful generation
    - Show AIChatInterface after meal plan is generated
    - _Requirements: 6.1, 6.2, 6.3_

  - [ ]* 7.6 Write property test for meal plan display completeness (Property 7)
    - **Property 7: Meal Plan Display Completeness**
    - Generate random meal plan structures with N meals → render → verify all meals and items shown
    - **Validates: Requirements 6.2**

  - [ ]* 7.7 Write property test for chat history preservation (Property 8)
    - **Property 8: Chat History Preservation**
    - Generate random message sequences → append to history → verify all messages in original order
    - **Validates: Requirements 6.5**

- [x] 8. Checkpoint - Verify meal planner and tracker
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Implement Community Chat Forum with Moderation
  - [x] 9.1 Create the /api/moderate API route
    - Create `src/app/api/moderate/route.ts`
    - Accept POST with message text
    - Call Perspective API to analyze toxicity
    - Return approved/rejected based on toxicity threshold
    - Fail open (allow message) if Perspective API is unavailable, with logging
    - _Requirements: 8.4, 8.5_

  - [x] 9.2 Build the ChatMessage component
    - Create `src/components/forum/ChatMessage.tsx`
    - Display message with author display name and timestamp
    - If message is removed, show community guidelines violation notice instead of original content
    - _Requirements: 8.3, 8.5_

  - [x] 9.3 Build the ChatForum component with Firestore integration
    - Create `src/components/forum/ChatForum.tsx`
    - Require display name entry (1-50 characters) before posting
    - Validate message length (1-2000 characters) before submission
    - Show inline error for empty or oversized messages
    - On submit: call /api/moderate, then write to Firestore (with removed flag if toxic)
    - Load messages from Firestore in reverse chronological order with real-time listener
    - Allow reading messages without posting
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_

  - [x] 9.4 Wire ChatForum into ResourcesPage
    - Import and render ChatForum at the bottom of ResourcesPage
    - _Requirements: 8.1_

  - [ ]* 9.5 Write property test for forum message length validation (Property 9)
    - **Property 9: Forum Message Length Validation**
    - Generate random strings of various lengths → verify validation accepts 1-2000, rejects otherwise
    - **Validates: Requirements 8.2, 8.7**

  - [ ]* 9.6 Write property test for display name length validation (Property 12)
    - **Property 12: Display Name Length Validation**
    - Generate random strings of various lengths → verify validation accepts 1-50, rejects otherwise
    - **Validates: Requirements 8.8**

  - [ ]* 9.7 Write property test for forum message ordering (Property 10)
    - **Property 10: Forum Message Chronological Ordering**
    - Generate random message sets with timestamps → verify reverse chronological ordering in display
    - **Validates: Requirements 8.3**

  - [ ]* 9.8 Write property test for removed message notice (Property 11)
    - **Property 11: Removed Message Notice Replacement**
    - Generate random messages with `removed: true` → verify displayed text is the notice, not original content
    - **Validates: Requirements 8.5**

- [x] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project uses TypeScript throughout with Next.js 14 App Router
- API keys (OpenAI, Perspective API) are stored in environment variables and accessed only via server-side API routes
- Firebase configuration is stored in environment variables

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "3.1", "3.2", "3.3"] },
    { "id": 3, "tasks": ["2.2", "2.3"] },
    { "id": 4, "tasks": ["5.1", "5.2", "6.1"] },
    { "id": 5, "tasks": ["5.3", "5.4", "5.5", "6.2"] },
    { "id": 6, "tasks": ["5.6", "6.3", "6.4", "6.5"] },
    { "id": 7, "tasks": ["7.1", "7.2"] },
    { "id": 8, "tasks": ["7.3", "7.4"] },
    { "id": 9, "tasks": ["7.5", "7.6", "7.7"] },
    { "id": 10, "tasks": ["9.1", "9.2"] },
    { "id": 11, "tasks": ["9.3"] },
    { "id": 12, "tasks": ["9.4", "9.5", "9.6", "9.7", "9.8"] }
  ]
}
```
