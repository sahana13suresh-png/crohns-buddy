# Requirements Document

## Introduction

Crohn's Buddy is an advocacy and helper website for Crohn's Disease patients, particularly teens and young adults. The website provides educational resources, a symptom tracker, an AI-powered meal planner, community forums, and team information. The site uses a blue color theme with the provided Crohn's Buddy logo (light blue background, "Crohn's Buddy" text in blue with heart and sparkle decorations).

## Glossary

- **Website**: The Crohn's Buddy web application accessible via a browser
- **Welcome_Page**: The landing page providing an overview and team introductions
- **About_Page**: The informational page covering Crohn's Disease and IBD education
- **Symptom_Tracker**: The calendar-based tool for patients to log daily health data
- **Meal_Planner**: The AI-powered quiz and chat system that generates personalized meal plans
- **Resources_Page**: The page containing external links and the community chat forum
- **Chat_Forum**: The community discussion section where patients communicate with each other
- **Moderation_System**: The automated system that detects and removes hateful or harmful comments
- **Quiz**: The six-section questionnaire within the Meal Planner that collects patient dietary and health information
- **AI_Chat**: The interactive conversation interface where patients refine meal plan suggestions with AI
- **Navigation**: The tab-based interface allowing users to switch between the five main sections
- **Patient**: A user of the website who has Crohn's Disease or IBD
- **Tracker_Entry**: A single daily log entry in the Symptom Tracker

## Requirements

### Requirement 1: Site Navigation and Theme

**User Story:** As a patient, I want a clean blue-themed website with easy tab navigation, so that I can quickly find the information and tools I need.

#### Acceptance Criteria

1. THE Website SHALL display the Crohn's Buddy logo in the header area using the provided logo asset (light blue background with "Crohn's Buddy" text in blue, heart and sparkle decorations)
2. THE Website SHALL use a blue color theme consistently across all pages, applying the theme to the header, navigation tabs, buttons, links, and section headings
3. THE Navigation SHALL provide five clearly labeled tabs in the following left-to-right order: "Welcome", "About Crohn's", "Symptom Tracker", "AI Meal Planner", and "Resources"
4. WHEN a user clicks a Navigation tab, THE Website SHALL display the corresponding page content without a full page reload
5. THE Navigation SHALL visually distinguish the currently active tab from inactive tabs using a distinct background color or underline style that provides a contrast ratio of at least 3:1 against inactive tabs
6. WHEN the Website is first loaded, THE Navigation SHALL set the "Welcome" tab as the active tab and display the Welcome_Page content by default
7. THE Navigation SHALL be operable via keyboard, allowing users to move focus between tabs and activate a tab using the Enter or Space key

### Requirement 2: Welcome Page

**User Story:** As a visitor, I want to see an overview of what Crohn's Buddy offers and meet the team behind it, so that I understand the purpose and credibility of the site.

#### Acceptance Criteria

1. THE Welcome_Page SHALL display an introductory section explaining the purpose and mission of Crohn's Buddy
2. THE Welcome_Page SHALL include a "Meet the Team" section listing team members with their roles
3. THE Welcome_Page SHALL display Sahana Suresh with the role "Founder and Crohn's Patient"
4. THE Welcome_Page SHALL display Annabelle Koo with the role "Marketing and Outreach"

### Requirement 3: About Crohn's Page

**User Story:** As a patient or visitor, I want to learn about Crohn's Disease and IBD through educational content, so that I can better understand the condition.

#### Acceptance Criteria

1. THE About_Page SHALL provide a section explaining what Crohn's Disease is, including a definition and its relationship to Inflammatory Bowel Disease (IBD)
2. THE About_Page SHALL provide a section explaining what Inflammatory Bowel Disease (IBD) is, including the types of conditions it encompasses
3. THE About_Page SHALL present a section covering common symptoms of Crohn's Disease
4. THE About_Page SHALL present a section covering known causes and risk factors of Crohn's Disease
5. THE About_Page SHALL present a section covering common treatment approaches for Crohn's Disease
6. THE About_Page SHALL organize all content under visible section headings that describe the topic of each section, with a minimum of four distinct labeled sections
7. THE About_Page SHALL present all content as static informational text readable without requiring user interaction or login

### Requirement 4: Symptom Tracker

**User Story:** As a patient, I want to log my daily symptoms in a calendar-like view, so that I can track patterns in my health over time.

#### Acceptance Criteria

1. THE Symptom_Tracker SHALL display a calendar-like view showing days of the current month, visually distinguishing days that have a saved Tracker_Entry from days without one
2. WHEN a user selects a day on the calendar that is today or in the past, THE Symptom_Tracker SHALL present a daily questionnaire form
3. THE Symptom_Tracker questionnaire SHALL include a free-text question about food consumed that day, accepting up to 500 characters
4. THE Symptom_Tracker questionnaire SHALL include a question about pain level experienced that day, captured on a numeric scale of 1 (no pain) to 10 (worst pain)
5. THE Symptom_Tracker questionnaire SHALL include a question about bowel movements that day, capturing the number of bowel movements as a value from 0 to 20
6. THE Symptom_Tracker questionnaire SHALL include at least one additional question about the patient's day (such as stress level, energy, or hydration)
7. WHEN a user submits a Tracker_Entry, THE Symptom_Tracker SHALL save the entry and associate it with the selected date
8. WHEN a user selects a day that already has a Tracker_Entry, THE Symptom_Tracker SHALL display the previously saved data in the questionnaire form and allow the user to update and re-submit the entry
9. THE Symptom_Tracker SHALL present the questionnaire as a single-page form requiring no more than one submission action to complete an entry
10. IF a user selects a future date on the calendar, THEN THE Symptom_Tracker SHALL not present the questionnaire form and SHALL indicate that entries can only be logged for today or past dates

### Requirement 5: AI Meal Planner Quiz

**User Story:** As a patient, I want to answer a detailed quiz about my health and food preferences, so that an AI can generate a personalized meal plan tailored to my Crohn's condition.

#### Acceptance Criteria

1. THE Meal_Planner SHALL display a disclaimer at the top of the quiz, visible without scrolling on initial page load, stating that the generated meal plan is not medical advice and that patients should consult their doctor
2. THE Meal_Planner SHALL label the feature clearly as an "AI" feature in the tab and page heading
3. THE Quiz SHALL contain six sections presented in sequential order: "Current Crohn's Status", "Medical Safety Questions", "Food Tolerance", "Food Preferences", "Lifestyle", and "Meal Planner Output", with a progress indicator showing the user which section they are currently on and how many sections remain
4. THE Quiz Section 1 (Current Crohn's Status) SHALL ask four questions covering: current flare status, current symptoms description, a checklist of common symptoms, and whether the patient's doctor has given specific diet instructions
5. THE Quiz Section 2 (Medical Safety Questions) SHALL ask four questions covering: history of surgery or bowel obstruction, recent significant weight loss, food allergies, and specific foods the patient must avoid
6. THE Quiz Section 3 (Food Tolerance) SHALL ask four questions covering: foods the patient considers safe, known trigger foods, foods the patient wants to test reintroducing, and current fiber tolerance level
7. THE Quiz Section 4 (Food Preferences) SHALL ask four questions covering: preferred meal types, foods the patient refuses to eat, protein preferences, and carbohydrate preferences
8. THE Quiz Section 5 (Lifestyle) SHALL ask four questions covering: desired meal plan duration type, available cooking time, access to kitchen appliances, and number of meals per day
9. THE Quiz Section 6 (Meal Planner Output) SHALL ask four questions covering: primary dietary goals, preferred output format, level of adventurousness with new foods, and any extra notes for the AI
10. WHEN the user completes all six sections of the Quiz by answering every question in each section, THE Meal_Planner SHALL compile all answers into a structured prompt that includes the user's responses organized by section name and question, and send it to the AI for meal plan generation
11. WHEN the user attempts to advance to the next section, IF any question in the current section is unanswered, THEN THE Quiz SHALL display an inline indication identifying which questions require a response and SHALL prevent advancement until all questions in the current section are answered
12. THE Quiz SHALL allow the user to navigate back to any previously completed section to review or edit answers before final submission

### Requirement 6: AI Meal Plan Generation and Chat

**User Story:** As a patient, I want the AI to generate a meal plan from my quiz answers and let me refine it through conversation, so that I get a plan that truly fits my needs.

#### Acceptance Criteria

1. WHEN the Quiz answers are compiled, THE Meal_Planner SHALL send the structured prompt to the AI, display a loading indicator during generation, and display the generated personalized meal plan to the user within 60 seconds
2. THE Meal_Planner SHALL display the AI-generated meal plan organized with labeled sections for each meal of the day, listing individual food items and portion descriptions per meal
3. THE AI_Chat SHALL provide a conversation interface below or adjacent to the generated meal plan
4. WHEN a user sends a message in the AI_Chat, THE AI_Chat SHALL respond with suggestions or modifications that reference the current meal plan content
5. THE AI_Chat SHALL maintain conversation history for the duration of the current session so the patient can iteratively refine the meal plan
6. IF the AI fails to generate a meal plan or a chat response, THEN THE Meal_Planner SHALL display an error message indicating the service is unavailable and allow the user to retry the request

### Requirement 7: Resources Page with External Links

**User Story:** As a patient or caregiver, I want access to curated external resources for Crohn's patients and teens, so that I can find additional support and information.

#### Acceptance Criteria

1. THE Resources_Page SHALL display a list of helpful external website links relevant to Crohn's Disease patients
2. THE Resources_Page SHALL include resources specifically relevant to teens with Crohn's Disease
3. THE Resources_Page SHALL include a link to Camp Oasis
4. WHEN a user clicks an external link, THE Resources_Page SHALL open the link in a new browser tab

### Requirement 8: Community Chat Forum

**User Story:** As a patient, I want a chat forum where I can talk to other Crohn's patients, so that I feel supported and connected to a community.

#### Acceptance Criteria

1. THE Chat_Forum SHALL be located at the bottom of the Resources_Page
2. THE Chat_Forum SHALL allow patients to post messages between 1 and 2000 characters visible to other forum users
3. THE Chat_Forum SHALL display messages in reverse chronological order, showing the most recent messages first, with each message displaying the author's display name and a timestamp
4. THE Moderation_System SHALL automatically detect and remove comments containing hate speech, slurs, threats of violence, or sexually explicit content posted in the Chat_Forum
5. WHEN the Moderation_System removes a comment, THE Moderation_System SHALL replace the comment content with a notice indicating the message was removed for violating community guidelines
6. THE Chat_Forum SHALL allow users to read messages without requiring them to post
7. IF a patient submits an empty message or a message exceeding 2000 characters, THEN THE Chat_Forum SHALL not post the message and SHALL display an error message indicating the length requirement
8. THE Chat_Forum SHALL require patients to enter a display name between 1 and 50 characters before posting a message
