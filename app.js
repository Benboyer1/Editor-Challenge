import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut, updateProfile } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, collection, addDoc, query, orderBy, limit, getDocs, where, getCountFromServer, setDoc, doc, getDoc, writeBatch, deleteDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD_Krda4l_oZPKH3TiZuIagvIVfhbYjJIE",
  authDomain: "editor-challenge.firebaseapp.com",
  projectId: "editor-challenge",
  storageBucket: "editor-challenge.firebasestorage.app",
  messagingSenderId: "309788249860",
  appId: "1:309788249860:web:1a36bcf4bba26435f90a51",
  measurementId: "G-Z6D6LBD7FC"
};

const firebaseApp = initializeApp(firebaseConfig);

// Dynamically import Analytics so tracker-blockers don't crash the app
let analytics = null;
import("https://www.gstatic.com/firebasejs/11.6.1/firebase-analytics.js").then((fbAnalytics) => {
    analytics = fbAnalytics.getAnalytics(firebaseApp);
    window.analytics = analytics;
    window.logEvent = fbAnalytics.logEvent;
}).catch((error) => {
    console.warn("Analytics blocked by browser tracking protection. Game will continue safely.");
});

const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const provider = new GoogleAuthProvider();
const PROFILE_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLIC_TAG_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ADMIN_EMAILS = ['bentzion.boyer@gmail.com'];

// Global PWA install event
window.deferredPrompt = null;

/**
 * MOBILE DETECTION
 */
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

const cloneUserProfile = (profile = {}) => ({
    username: profile.username || 'Guest Player',
    avatar: profile.avatar || '👤',
    avatarColor: profile.avatarColor || 'bg-slate-200',
    publicTag: profile.publicTag || '',
    lastProfileChangeAt: profile.lastProfileChangeAt || null
});

const toDateOrNull = (value) => {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value?.toDate === 'function') return value.toDate();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const createPublicTagCandidate = () => {
    let tag = '#';
    for (let i = 0; i < 4; i++) {
        tag += PUBLIC_TAG_ALPHABET[Math.floor(Math.random() * PUBLIC_TAG_ALPHABET.length)];
    }
    return tag;
};

const generateUniquePublicTag = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = createPublicTagCandidate();
        const existing = await getDocs(query(collection(db, 'users'), where('publicTag', '==', candidate), limit(1)));
        if (existing.empty) return candidate;
    }
    throw new Error('Unable to generate a unique public tag.');
};

const isAdminUser = (user) => !!user?.email && ADMIN_EMAILS.includes(user.email.toLowerCase());

const authEngine = {
    login: async function() {
        try {
            await signInWithPopup(auth, provider);
        } catch (error) {
            console.log('Firebase login failed', error);
        }
    },
    logout: async function() {
        try {
            await signOut(auth);
            window.ui.closeSidebar();
            updateAuthUI(null);
        } catch (error) {
            console.log('Firebase logout failed', error);
        }
    },
    updateName: async function() {
        const input = document.getElementById('sidebar-name-input');
        if (!input) return;
        const newName = input.value.trim();
        if (!newName) return;

        const user = auth.currentUser;
        if (!user) {
            alert('Sign in to update your name.');
            return;
        }

        try {
            await updateProfile(user, { displayName: newName });
            input.value = '';
            updateAuthUI(auth.currentUser);
        } catch (error) {
            console.error('Name update failed', error);
            alert('Unable to update your name. Try again.');
        }
    },
    
    saveProfile: async function() {
        const user = auth.currentUser;
        if (!user) {
            console.error('User not authenticated');
            return;
        }

        const existingProfile = cloneUserProfile(window.game.state.savedUserProfile || window.game.state.userProfile);
        const inputUsername = document.getElementById('profile-username-input')?.value?.trim() || '';
        let username = inputUsername || existingProfile.username || 'Guest Player';

        // Get selected emoji and color from state (these should be set by UI functions)
        const selectedEmoji = window.game.state.userProfile.avatar;
        const selectedColor = window.game.state.userProfile.avatarColor;
        const publicTag = existingProfile.publicTag || await generateUniquePublicTag();

        const usernameChanged = username !== existingProfile.username;
        const avatarChanged = selectedEmoji !== existingProfile.avatar || selectedColor !== existingProfile.avatarColor;

        const lastChangeAt = toDateOrNull(existingProfile.lastProfileChangeAt);
        let newProfileChangeAt = existingProfile.lastProfileChangeAt;

        if (usernameChanged && !window.game.state.isAdmin && lastChangeAt && (Date.now() - lastChangeAt.getTime()) < PROFILE_CHANGE_COOLDOWN_MS) {
            const nextChangeDate = new Date(lastChangeAt.getTime() + PROFILE_CHANGE_COOLDOWN_MS);
            alert(`Usernames can only be changed once every 7 days. (Available after ${nextChangeDate.toLocaleDateString()}).\n\nYour avatar changes will still be saved!`);
            username = existingProfile.username; // Revert the name change
            if (!avatarChanged) {
                const usernameInput = document.getElementById('profile-username-input');
                if (usernameInput) usernameInput.value = username;
                return;
            }
        } else if (username !== existingProfile.username) {
            newProfileChangeAt = new Date();
        }

        try {
            const updatedAt = new Date();
            // Save profile to users collection with merge: true
            const userDocRef = doc(db, 'users', user.uid);
            await setDoc(userDocRef, {
                username,
                avatar: selectedEmoji,
                avatarColor: selectedColor,
                publicTag,
                lastProfileChangeAt: newProfileChangeAt || null,
                updatedAt: updatedAt
            }, { merge: true });

            try {
                const gamesQuery = query(collection(db, 'games'), where('uid', '==', user.uid));
                const querySnapshot = await getDocs(gamesQuery);

                const batches = [];
                let currentBatch = writeBatch(db);
                let operationCount = 0;

                querySnapshot.forEach((gameDoc) => {
                    currentBatch.update(gameDoc.ref, {
                        username,
                        avatar: selectedEmoji,
                        avatarColor: selectedColor,
                        publicTag
                    });
                    operationCount++;

                    if (operationCount === 490) { // Firestore limit is 500, chunking to be safe
                        batches.push(currentBatch.commit());
                        currentBatch = writeBatch(db);
                        operationCount = 0;
                    }
                });

                if (operationCount > 0) {
                    batches.push(currentBatch.commit());
                }

                await Promise.all(batches);
            } catch (error) {
                console.warn("Could not backfill past scores:", error);
            }

            // Update global state
            window.game.state.userProfile = {
                username,
                avatar: selectedEmoji,
                avatarColor: selectedColor,
                publicTag,
                lastProfileChangeAt: newProfileChangeAt || null
            };
            window.game.state.savedUserProfile = cloneUserProfile(window.game.state.userProfile);

            // Update header and close modal
            window.ui.updateHeaderProfile();
            window.ui.toggleModal('modal-profile', false);
        } catch (error) {
            console.error('Error saving profile:', error);
            alert('Unable to save profile. Try again.');
        }
    }
};
window.authEngine = authEngine;

const updateAuthUI = (user) => {
    const profileButton = document.getElementById('btn-user-profile');
    const headerAvatar = document.getElementById('header-avatar');
    const sidebarAvatar = document.getElementById('sidebar-avatar');
    const sidebarUsername = document.getElementById('sidebar-username');
    const leaderboardButton = document.getElementById('btn-leaderboard-home');
    const guestUI = document.getElementById('guest-ui');
    const loggedInUI = document.getElementById('logged-in-ui');
    const loggedInUIBottom = document.getElementById('logged-in-ui-bottom');
    const leaderboardLoginPrompt = document.getElementById('leaderboard-login-prompt');
    const adminPanel = document.getElementById('admin-panel');
    const adminBadge = document.getElementById('sidebar-admin-badge');

    if (!profileButton || !headerAvatar || !sidebarAvatar || !sidebarUsername || !leaderboardButton || !guestUI || !loggedInUI || !loggedInUIBottom || !leaderboardLoginPrompt) return;

    if (user) {
        profileButton.classList.remove('hidden');
        headerAvatar.src = user.photoURL || 'https://www.gravatar.com/avatar/?d=mp';
        sidebarUsername.innerText = user.displayName || 'Player';
        leaderboardButton.disabled = false;
        leaderboardButton.classList.remove('opacity-40', 'cursor-not-allowed');
        guestUI.classList.add('hidden');
        loggedInUI.classList.remove('hidden');
        loggedInUIBottom.classList.remove('hidden');
        leaderboardLoginPrompt.classList.add('hidden');
        if (window.game.state.isAdmin) {
            adminPanel?.classList.remove('hidden');
            adminBadge?.classList.remove('hidden');
        } else {
            adminPanel?.classList.add('hidden');
            adminBadge?.classList.add('hidden');
        }
    } else {
        profileButton.classList.remove('hidden');
        headerAvatar.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iY3VycmVudENvbG9yIj48cGF0aCBkPSJNMTIgMTJjMi43NiAwIDUtMi4yNCA1LTVzLTIuMjQtNS01LTUtNSAyLjI0LTUgNSAyLjI0IDUgNSA1eiIvPjxwYXRoIGQ9Ik00IDIyYzAtNCA0LTcgOC03czggMyA4IDd2MUg0di0xeiIvPjwvc3ZnPg==';
        sidebarAvatar.innerText = '👤';
        sidebarAvatar.className = 'w-20 h-20 rounded-full flex items-center justify-center text-4xl shadow-md mx-auto mb-2 bg-slate-200';
        sidebarUsername.innerText = 'Player';
        leaderboardButton.disabled = false;
        leaderboardButton.classList.remove('opacity-40', 'cursor-not-allowed');
        guestUI.classList.remove('hidden');
        loggedInUI.classList.add('hidden');
        loggedInUIBottom.classList.add('hidden');
        leaderboardLoginPrompt.classList.remove('hidden');
        adminPanel?.classList.add('hidden');
        adminBadge?.classList.add('hidden');
    }
};

/**
 * AUDIO ENGINE
 * Uses Web Audio API for synthetic sounds (no external files).
 */
const audio = {
    ctx: null,
    enabled: true,
    init: async function() {
        if (!this.enabled) return;
        try {
            if (!this.ctx) {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (AudioContext) {
                    this.ctx = new AudioContext();
                }
            }
            if (this.ctx && this.ctx.state === 'suspended') {
                await this.ctx.resume().catch(() => {});
            }
        } catch (e) {
            console.log("Audio init failed", e);
        }
    },
    resumeIfNeeded: async function() {
        if (!this.enabled || !this.ctx) return;
        if (this.ctx.state === 'suspended') {
            await this.ctx.resume().catch(() => {});
        }
    },
    playTone: async function(freq, type, duration, vol = 0.1) {
        if (window.game?.state?.globalMuted) return;
        if (!this.enabled) return;
        if (!this.ctx) await this.init();
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') {
            await this.ctx.resume().catch(() => {});
            if (this.ctx.state === 'suspended') return;
        }
        try {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
            gain.gain.setValueAtTime(vol, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start();
            osc.stop(this.ctx.currentTime + duration);
        } catch (e) {
            console.log("Audio playTone failed", e);
        }
    },
    success: function() {
        this.playTone(523.25, 'sine', 0.1); // C5
        setTimeout(() => this.playTone(659.25, 'sine', 0.1), 100); // E5
    },
    fail: function() {
        this.playTone(150, 'sawtooth', 0.3);
        setTimeout(() => this.playTone(100, 'sawtooth', 0.3), 150);
    },
    click: function() {
        this.playTone(800, 'triangle', 0.05, 0.05);
    },
    bentzy: function() {
        // Happy Major Arpeggio for Easter Egg
        [523.25, 659.25, 783.99, 1046.50].forEach((freq, i) => {
            setTimeout(() => this.playTone(freq, 'square', 0.2, 0.1), i * 100);
        });
    },
    toggleAudio: async function() {
        window.game.state.globalMuted = !window.game.state.globalMuted;
        this.enabled = !window.game.state.globalMuted;
        if (!window.game.state.globalMuted) {
            await this.init();
        }
        window.ui.updateAudioToggle();
    }
};
window.audio = audio;

// Resume audio automatically when the page becomes active again or when the user interacts.
const audioResumeHandler = () => {
    if (audio.enabled) audio.init();
};
document.addEventListener('pointerdown', audioResumeHandler, { passive: true });
document.addEventListener('keydown', audioResumeHandler, { passive: true });
window.addEventListener('focus', audioResumeHandler);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') audioResumeHandler();
});

const questionTypeDetails = {
    Punctuation: "These questions check whether punctuation marks like commas, periods, and semicolons are used in the right spots to make sentences clear.",
    Syntax: "These questions look at sentence structure and word order, so the sentence makes sense and doesn't confuse the reader.",
    Hyphens: "These questions check whether words should be joined with a hyphen, like 'small-business owner' instead of 'small business owner.'",
    "Word Choice": "These questions ask whether the best word was chosen, especially for pairs that sound similar or are often mixed up.",
    Usage: "These questions cover common grammar habits, like choosing the right pronoun or preposition in a sentence.",
    Homophones: "These questions test words that sound the same but have different spellings and meanings, like there/their/they're.",
    Spelling: "These questions check whether a word is spelled correctly, catching common mistakes people make.",
    "Subject-Verb": "These questions make sure the verb matches the subject, such as 'she runs' versus 'they run.'",
    Agreement: "These questions make sure parts of the sentence match each other, like pronouns and verbs.",
    Apostrophes: "These questions check if apostrophes are used correctly for ownership or contractions.",
    Pronouns: "These questions help you choose the right pronoun, like who vs. whom or I vs. me.",
    Adjectives: "These questions check whether the sentence uses the right descriptive word for a noun.",
    Adverbs: "These questions check whether the sentence uses the right word to describe an action or another description.",
    Style: "These questions help make writing clearer and easier to read.",
    Capitalization: "These questions check whether names and sentence starts are capitalized correctly.",
    Comparison: "These questions check whether you should use a comparison word like better, best, more, or most.",
    Other: "These questions help explain a simple rule that makes the sentence clearer or more correct."
};

/**
 * QUESTION DATABASE - 150+ UNIQUE ITEMS
 */
const questionDB = [
    // --- PUNCTUATION & FORMATTING ---
    { t: 'binary', cat: 'Punctuation', q: "To my parents, Ayn Rand and God.", a: false, exp: "Without the Oxford comma before 'and', this sentence implies your parents ARE Ayn Rand and God. Use 'To my parents, Ayn Rand, and God.'" },
    { t: 'binary', cat: 'Punctuation', q: "We invited the acrobats, clown, and jugglers to the party.", a: true, exp: "The Oxford comma correctly clarifies that JFK and Stalin aren't the acrobats." },
    { t: 'binary', cat: 'Punctuation', q: "I ordered a latte; but I got a cappuccino.", a: false, exp: "Do not use a semicolon alongside a coordinating conjunction (like 'but'). Use a comma, or drop the 'but'." },
    { t: 'binary', cat: 'Punctuation', q: "Heavy snow is forecast; therefore, the pass is closed.", a: true, exp: "This is the correct way to use a semicolon to connect two related independent clauses using a conjunctive adverb." },
    { t: 'binary', cat: 'Punctuation', q: "The ingredients are: flour, sugar, and butter.", a: false, exp: "Do not place a colon between a verb ('are') and its objects. Just write 'The ingredients are flour, sugar, and butter.'" },
    { t: 'binary', cat: 'Punctuation', q: "Bring these items: a flashlight, a map, and water.", a: true, exp: "A colon is correctly used here because it follows a complete, independent clause ('Bring these items')." },
    { t: 'mc', cat: 'Punctuation', q: "Which list is punctuated correctly?", options: ["Paris, France, London, England, and Rome, Italy.", "Paris, France; London, England; and Rome, Italy."], a: 1, exp: "When list items themselves contain commas (like city, country), use semicolons to separate the main items to avoid confusion." },
    { t: 'mc', cat: 'Punctuation', q: "How should this quote be punctuated?", options: ["He asked, \"Are you ready?\"", "He asked \"Are you ready?\""], a: 0, exp: "Use a comma to introduce a direct quotation, and keep the question mark inside the quotation marks if it belongs to the quote." },
    { t: 'binary', cat: 'Punctuation', q: "My mother who is a nurse is kind.", a: false, exp: "Because you only have one mother, 'who is a nurse' is non-essential information. It must be set off by commas: 'My mother, who is a nurse, is kind.'" },
    { t: 'binary', cat: 'Punctuation', q: "The boy who broke the window ran away.", a: true, exp: "Correct. 'who broke the window' is essential to identifying WHICH boy ran away, so no commas are used." },
    { t: 'binary', cat: 'Punctuation', q: "It was raining, we stayed inside.", a: false, exp: "This is a comma splice. You cannot join two complete sentences with just a comma. Use a semicolon, a period, or add 'so/and'." },
    { t: 'binary', cat: 'Punctuation', q: "He said; 'Hello.'", a: false, exp: "Never use a semicolon to introduce a short quotation. Use a comma: He said, 'Hello.'" },
    { t: 'binary', cat: 'Punctuation', q: "Dear Hiring Manager:", a: true, exp: "Colons are the standard and correct punctuation for formal business letter greetings." },
    { t: 'mc', cat: 'Punctuation', q: "Which uses the em dash correctly?", options: ["I am tired - very tired.", "I am tired—very tired."], a: 1, exp: "An em dash (—) is used to show a strong break in thought. A standard hyphen (-) is only used to connect words." },

    // --- APOSTROPHES & PLURALS ---
    { t: 'binary', cat: 'Apostrophes', q: "Its a nice day.", a: false, exp: "Missing apostrophe. 'It's' is the contraction for 'It is'. 'Its' shows ownership." },
    { t: 'binary', cat: 'Apostrophes', q: "The dog chased its tail.", a: true, exp: "Correct. The possessive form of 'it' does not have an apostrophe." },
    { t: 'binary', cat: 'Apostrophes', q: "Lets go home.", a: false, exp: "Missing apostrophe. 'Let's' is the contraction for 'Let us'." },
    { t: 'binary', cat: 'Apostrophes', q: "The 1990's were great.", a: false, exp: "Do not use an apostrophe to make decades or acronyms plural. It should be '1990s'." },
    { t: 'mc', cat: 'Apostrophes', q: "What is the plural possessive of 'dog'?", options: ["The dog's bone", "The dogs' bone", "The dogs bone"], a: 1, exp: "First make it plural (dogs), then add the apostrophe (dogs') to show they own the bone." },
    { t: 'mc', cat: 'Apostrophes', q: "Which is correct?", options: ["Womens' clothing", "Women's clothing"], a: 1, exp: "Because 'women' is already plural, you just add 's to make it possessive." },
    { t: 'mc', cat: 'Apostrophes', q: "Which is correct?", options: ["The Joneses are coming over.", "The Jones's are coming over."], a: 0, exp: "To make a name ending in 's' plural, add 'es'. Do not use an apostrophe unless showing ownership." },
    { t: 'mc', cat: 'Apostrophes', q: "Whose car is this?", options: ["Who's", "Whose"], a: 1, exp: "'Whose' shows possession. 'Who's' means 'Who is'." },

    // --- SYNTAX, MODIFIERS & PARALLELISM ---
    { t: 'binary', cat: 'Syntax', q: "Running to the store, the rain began to fall.", a: false, exp: "This is a dangling modifier. The phrase 'Running to the store' must immediately precede the person who is running, not the rain." },
    { t: 'binary', cat: 'Syntax', q: "To improve his results, the experiment was repeated.", a: false, exp: "Dangling modifier. The sentence is missing the person who is trying 'to improve his results'. For example: 'To improve his results, the scientist repeated the experiment.'" },
    { t: 'binary', cat: 'Syntax', q: "Barking loudly, the dog chased the mailman.", a: true, exp: "Correct. The descriptive phrase 'Barking loudly' is immediately followed by the noun it describes (the dog)." },
    { t: 'binary', cat: 'Syntax', q: "Exhausted from the trip, the suitcase felt heavy.", a: false, exp: "This is a misplaced modifier. Because 'the suitcase' comes immediately after the comma, the sentence accidentally implies the suitcase was exhausted." },
    { t: 'binary', cat: 'Syntax', q: "She likes swimming, hiking, and to run.", a: false, exp: "This breaks parallelism. Items in a list must follow the same grammatical pattern. It should be 'swimming, hiking, and running'." },
    { t: 'binary', cat: 'Syntax', q: "He is smart, funny, and kind.", a: true, exp: "Correct parallel structure. All three items in the list are simple adjectives." },
    { t: 'mc', cat: 'Syntax', q: "Fix the sentence: 'I only have eyes for you.'", options: ["I have only eyes for you.", "I have eyes only for you.", "No change."], a: 1, exp: "Modifiers like 'only' should be placed exactly next to the word they modify. You don't 'only have' eyes, you have eyes 'only for you'." },
    { t: 'mc', cat: 'Syntax', q: "Choose the correct sentence:", options: ["I nearly ate the whole cake.", "I ate nearly the whole cake."], a: 1, exp: "'Nearly' modifies 'the whole cake'. If you 'nearly ate' it, it means you thought about eating it but didn't." },
    { t: 'mc', cat: 'Style', q: "Choose the active voice:", options: ["The ball was thrown by John.", "John threw the ball."], a: 1, exp: "Active voice (where the subject performs the action) is stronger and more direct than passive voice." },

    // --- WORD CHOICE & USAGE (Diction) ---
    { t: 'binary', cat: 'Word Choice', q: "The amount of people was high.", a: false, exp: "Use 'amount' for things you can't count (water, courage). Use 'number' for things you can count (people, cars)." },
    { t: 'binary', cat: 'Word Choice', q: "I have less dollars than you.", a: false, exp: "Use 'fewer' for items you can count individually (dollars). Use 'less' for bulk concepts (money)." },
    { t: 'binary', cat: 'Word Choice', q: "I couldn't care less.", a: true, exp: "Correct. This idiom means your care is at zero. Saying 'I could care less' implies you still care a little bit." },
    { t: 'binary', cat: 'Word Choice', q: "She complimented my shoes.", a: true, exp: "Correct. A 'compliment' is praise. A 'complement' is something that completes or goes well with something else." },
    { t: 'binary', cat: 'Word Choice', q: "The wine compliments the cheese.", a: false, exp: "Incorrect. The wine doesn't speak to praise the cheese; it 'complements' (completes/enhances) it." },
    { t: 'binary', cat: 'Word Choice', q: "He is disinterested in the game.", a: false, exp: "If he is bored, he is 'uninterested'. 'Disinterested' means impartial or unbiased (like a referee)." },
    { t: 'binary', cat: 'Word Choice', q: "I am anxious to see you.", a: false, exp: "'Anxious' implies fear or dread. If you are looking forward to it, use 'eager'." },
    { t: 'binary', cat: 'Word Choice', q: "She is nauseous.", a: false, exp: "Technically, 'nauseous' means causing nausea (like toxic fumes). If you feel sick, you are 'nauseated'. (Though 'nauseous' is highly common in casual speech)." },
    { t: 'binary', cat: 'Word Choice', q: "The media are investigating.", a: true, exp: "Correct. 'Media' is the plural form of the singular word 'medium'." },
    { t: 'mc', cat: 'Word Choice', q: "The detective tried to ____ a confession.", options: ["illicit", "elicit"], a: 1, exp: "To 'elicit' means to draw out or extract. 'Illicit' means illegal." },
    { t: 'mc', cat: 'Word Choice', q: "The movie had a profound ____ on me.", options: ["affect", "effect"], a: 1, exp: "Use 'effect' when you need a noun (the result). Use 'affect' when you need a verb (the action of changing something)." },
    { t: 'mc', cat: 'Word Choice', q: "I am going to ____ down for a nap.", options: ["lie", "lay"], a: 0, exp: "You 'lie' yourself down. You 'lay' an object down (like laying a book on a table)." },
    { t: 'mc', cat: 'Word Choice', q: "The prisoner was ____ at dawn.", options: ["hung", "hanged"], a: 1, exp: "When referring to the execution of a human being, the past tense is 'hanged'. Pictures and coats are 'hung'." },
    { t: 'mc', cat: 'Word Choice', q: "The storm is ____.", options: ["imminent", "eminent"], a: 0, exp: "'Imminent' means about to happen. 'Eminent' means distinguished or famous." },
    { t: 'mc', cat: 'Word Choice', q: "I don't want to ____ the game.", options: ["loose", "lose"], a: 1, exp: "'Lose' is the opposite of win. 'Loose' is the opposite of tight." },
    { t: 'mc', cat: 'Word Choice', q: "She ____ that she was tired by yawning.", options: ["implied", "inferred"], a: 0, exp: "The person giving the signal 'implies'. The person receiving the signal 'infers'." },
    { t: 'mc', cat: 'Word Choice', q: "The ____ rain (stopping and starting all day) was annoying.", options: ["continuous", "continual"], a: 1, exp: "'Continual' means happening repeatedly with breaks. 'Continuous' means never stopping at all." },
    { t: 'mc', cat: 'Word Choice', q: "I need to go ____ down the road.", options: ["further", "farther"], a: 1, exp: "Use 'farther' for measurable physical distance. Use 'further' for metaphorical depth or time." },

    // --- PRONOUNS & VERB AGREEMENT ---
    { t: 'mc', cat: 'Pronouns', q: "____ and I are going to the mall.", options: ["Him", "He"], a: 1, exp: "If you remove 'and I', you would say 'He is going', not 'Him is going'." },
    { t: 'mc', cat: 'Pronouns', q: "Please give the report to ____.", options: ["she", "her"], a: 1, exp: "Use the object case 'her' after a preposition like 'to'." },
    { t: 'mc', cat: 'Pronouns', q: "This is a secret between you and ____.", options: ["I", "me"], a: 1, exp: "'Between' is a preposition, which must be followed by the object case 'me', never 'I'." },
    { t: 'mc', cat: 'Pronouns', q: "____ do you trust?", options: ["Who", "Whom"], a: 1, exp: "Rephrase it: Do you trust HIM or HE? Since it's HIM, use WHOM." },
    { t: 'mc', cat: 'Usage', q: "If I ____ you, I would accept.", options: ["was", "were"], a: 1, exp: "When speaking hypothetically (the subjunctive mood), always use 'were' instead of 'was'." },
    { t: 'mc', cat: 'Agreement', q: "The team ____ winning the game.", options: ["is", "are"], a: 0, exp: "In American English, collective nouns like 'team', 'group', or 'family' are treated as a single unit (singular)." },
    { t: 'mc', cat: 'Agreement', q: "None of the pie ____ left.", options: ["is", "are"], a: 0, exp: "When 'none' refers to a mass noun (like pie or water), it takes a singular verb." },
    { t: 'mc', cat: 'Agreement', q: "There ____ a dog and a cat in the yard.", options: ["is", "are"], a: 0, exp: "When a list follows 'There is/are', the verb matches the very first noun in the list. Since 'a dog' is singular, use 'is'." },
    { t: 'mc', cat: 'Agreement', q: "Neither the boss nor the workers ____ happy.", options: ["was", "were"], a: 1, exp: "In a neither/nor pairing, the verb must agree with the noun closest to it ('workers')." },

    // --- ADJECTIVES & ADVERBS ---
    { t: 'mc', cat: 'Adjectives', q: "I feel ____.", options: ["bad", "badly"], a: 0, exp: "'Feel' is a linking verb that describes your state of being, so it takes an adjective. Saying 'I feel badly' implies your fingers don't work." },
    { t: 'mc', cat: 'Adjectives', q: "He runs ____.", options: ["good", "well"], a: 1, exp: "Action verbs ('runs') must be modified by adverbs. 'Well' is the adverb form of 'good'." },
    { t: 'mc', cat: 'Adjectives', q: "I am ____ tired.", options: ["real", "really"], a: 1, exp: "Adverbs ('really') are used to modify adjectives ('tired'). 'Real' is an adjective." },

    // --- REDUNDANCY & STYLE ---
    { t: 'binary', cat: 'Style', q: "He entered his PIN number into the ATM machine.", a: false, exp: "Redundant. PIN stands for Personal Identification Number, and ATM stands for Automated Teller Machine." },
    { t: 'binary', cat: 'Style', q: "It was an unexpected surprise.", a: false, exp: "Redundant. All surprises are unexpected by definition." },
    { t: 'binary', cat: 'Style', q: "We need to learn the basic fundamentals.", a: false, exp: "Redundant. Fundamentals are inherently basic." },
    { t: 'binary', cat: 'Style', q: "They arrived at exactly the same time.", a: false, exp: "Redundant. If things are the same, they are already exact." },
    { t: 'mc', cat: 'Style', q: "Simplify: 'In the event that it rains'", options: ["If it rains", "When it rains"], a: 0, exp: "Always favor concise, direct language over bloated corporate jargon." },
    { t: 'mc', cat: 'Style', q: "Simplify: 'At this point in time'", options: ["Currently", "Now"], a: 1, exp: "'Now' is the most direct and punchy replacement for this common filler phrase." },

    // --- PHRASAL VERBS & SPACING ---
    { t: 'binary', cat: 'Spelling', q: "I need to setup my new computer.", a: false, exp: "'Setup' is a noun (The setup is nice). When used as an action, it must be two words: 'set up'." },
    { t: 'binary', cat: 'Spelling', q: "Please log in to your account.", a: true, exp: "Correct. 'Log in' is the verb action. 'Login' is the noun (Here is my login)." },
    { t: 'binary', cat: 'Spelling', q: "I brush my teeth everyday.", a: false, exp: "'Everyday' is an adjective meaning common (an everyday occurrence). The action of doing something daily is two words: 'every day'." },
    { t: 'binary', cat: 'Spelling', q: "We need to workout today.", a: false, exp: "'Workout' is a noun (That was a good workout). The action verb must be separated: 'work out'." },
    { t: 'binary', cat: 'Spelling', q: "Let's meet sometime next week.", a: true, exp: "Correct. 'Sometime' means an unspecified point in time. 'Some time' means a duration (It took some time)." },

    // --- HYPHENS ---
    { t: 'binary', cat: 'Hyphens', q: "She is a small business owner.", a: false, exp: "Without a hyphen, this could mean the owner is physically small. It should be 'small-business owner'." },
    { t: 'binary', cat: 'Hyphens', q: "He is a well known author.", a: false, exp: "Compound adjectives coming BEFORE the noun they modify must be hyphenated: 'well-known author'." },
    { t: 'binary', cat: 'Hyphens', q: "The author is well known.", a: true, exp: "Correct. When the compound adjective comes AFTER the noun, it is usually not hyphenated." },
    { t: 'binary', cat: 'Hyphens', q: "It is a highly-effective strategy.", a: false, exp: "Never put a hyphen after an adverb ending in '-ly'." },

    // --- CAPITALIZATION ---
    { t: 'binary', cat: 'Capitalization', q: "I spoke to President Lincoln.", a: true, exp: "Correct. Capitalize a job title when it comes directly before a name." },
    { t: 'binary', cat: 'Capitalization', q: "The President of the company resigned.", a: false, exp: "Job titles are generally strictly lowercased when used alone or after a name (unless referring to a specific head of state in certain style guides)." },
    { t: 'binary', cat: 'Capitalization', q: "I live in the South.", a: true, exp: "Correct. Capitalize directions when they refer to a specific geographic region." },
    { t: 'binary', cat: 'Capitalization', q: "Drive South for two miles.", a: false, exp: "Do not capitalize directions when they simply refer to compass routing." },
    { t: 'binary', cat: 'Capitalization', q: "I am taking History 101.", a: true, exp: "Correct. Capitalize specific course titles." },
    { t: 'binary', cat: 'Capitalization', q: "I am taking a History class.", a: false, exp: "Do not capitalize general academic subjects unless they are languages (like English or French)." },

    // --- QUICKFIRE SPELLING & HOMOPHONES ---
    { t: 'binary', cat: 'Spelling', q: "I will definately be there.", a: false, exp: "The correct spelling is 'definitely'. A helpful trick is to remember it contains the word 'finite'." },
    { t: 'binary', cat: 'Spelling', q: "Please separate the items.", a: true, exp: "Remember: There is 'a rat' in separate." },
    { t: 'binary', cat: 'Spelling', q: "It was a weird experience.", a: true, exp: "Correct. 'Weird' is one of the most famous exceptions to the 'I before E except after C' rule." },
    { t: 'binary', cat: 'Spelling', q: "The hotel can accomodate us.", a: false, exp: "'Accommodate' is tricky because it has two C's AND two M's." },
    { t: 'binary', cat: 'Spelling', q: "He is a liaison for the company.", a: true, exp: "Correct spelling. It has three vowels in a row: i-a-i." },
    { t: 'binary', cat: 'Spelling', q: "It is a priviledge.", a: false, exp: "The correct spelling is 'privilege'. There is no 'D' in the word." },
    { t: 'binary', cat: 'Spelling', q: "This supersedes the old rule.", a: true, exp: "Correct. 'Supersede' is the only word in English that ends in -sede." },
    { t: 'binary', cat: 'Spelling', q: "We reached a concensus.", a: false, exp: "The correct spelling is 'consensus', rooted in the word 'consent'." },
    { t: 'binary', cat: 'Usage', q: "I could care less about the result.", a: false, exp: "If you 'could care less', it means you currently care at least a little bit. The correct phrase is 'couldn't care less'." },
    { t: 'binary', cat: 'Usage', q: "Irregardless of the outcome.", a: false, exp: "'Irregardless' is non-standard and a double negative. Use 'Regardless'." },
    { t: 'binary', cat: 'Word Choice', q: "I have alot of friends.", a: false, exp: "'Alot' is not a recognized word. It should always be written as two separate words: 'a lot'." },
    { t: 'binary', cat: 'Word Choice', q: "He snuck out of the house.", a: true, exp: "While 'sneaked' is the traditional past tense, 'snuck' is widely accepted in modern American English." },
    { t: 'binary', cat: 'Usage', q: "He graduated college in 2010.", a: false, exp: "You don't graduate a college; you graduate FROM a college." },
    { t: 'binary', cat: 'Usage', q: "Where are you at?", a: false, exp: "The 'at' is redundant. Standard grammar avoids ending sentences with prepositions when they add no meaning. Just ask, 'Where are you?'" },
    { t: 'binary', cat: 'Comparison', q: "He is the oldest of the two brothers.", a: false, exp: "When comparing exactly two things, use the comparative form '-er' ('older'). Use '-est' ('oldest') for three or more." },
    { t: 'binary', cat: 'Comparison', q: "That painting is very unique.", a: false, exp: "'Unique' means 'one of a kind'. Since something cannot be 'very' one of a kind, you should not use modifiers with it." },
    { t: 'binary', cat: 'Usage', q: "You need to nip it in the butt.", a: false, exp: "The correct idiom is 'nip it in the bud,' comparing stopping a problem early to snipping a flower bud before it blooms." },
    { t: 'binary', cat: 'Usage', q: "It is a mute point.", a: false, exp: "The correct phrase is 'moot point', meaning an issue that is debatable or no longer relevant, not 'mute' (silent)." },
    { t: 'binary', cat: 'Usage', q: "He is at your beckon call.", a: false, exp: "The correct idiom is 'beck and call'. 'Beck' is a shortened form of the word 'beckon'." },
    { t: 'binary', cat: 'Usage', q: "First come, first serve.", a: false, exp: "The phrase is 'First come, first served', meaning the first person to arrive is the first to BE served." },
    { t: 'binary', cat: 'Usage', q: "They are one in the same.", a: false, exp: "The correct phrase is 'one and the same', emphasizing that two things are exactly identical." },
    { t: 'binary', cat: 'Usage', q: "Case and point.", a: false, exp: "The correct idiom is 'case in point', meaning an instance that serves as a perfect example of what is being discussed." },
    
    // --- HOMOPHONES ---
    { t: 'mc', cat: 'Homophones', q: "I need a ____ of paper.", options: ["piece", "peace"], a: 0, exp: "'Piece' means a part of something. 'Peace' means calm or without war." },
    { t: 'mc', cat: 'Homophones', q: "The ____ of the school is strict.", options: ["principal", "principle"], a: 0, exp: "A 'principal' is the head of a school (remember: they are your 'pal'). A 'principle' is a fundamental rule." },
    { t: 'mc', cat: 'Homophones', q: "It is a matter of ____.", options: ["principal", "principle"], a: 1, exp: "A 'principle' is a rule, belief, or moral." },
    { t: 'mc', cat: 'Homophones', q: "The car remained ____.", options: ["stationary", "stationery"], a: 0, exp: "'Stationary' with an 'A' means parked or not moving." },
    { t: 'mc', cat: 'Homophones', q: "I wrote on fancy ____.", options: ["stationary", "stationery"], a: 1, exp: "'Stationery' with an 'E' refers to paper and envelopes (E for Envelope)." },
    { t: 'mc', cat: 'Homophones', q: "Please ____ the rules.", options: ["cite", "site"], a: 0, exp: "To 'cite' means to reference or quote something." },
    { t: 'mc', cat: 'Homophones', q: "This is a construction ____.", options: ["cite", "site"], a: 1, exp: "A 'site' is a physical location or area." },
    { t: 'mc', cat: 'Homophones', q: "The ____ of the story.", options: ["moral", "morale"], a: 0, exp: "A 'moral' is a lesson learned from a story." },
    { t: 'mc', cat: 'Homophones', q: "Team ____ is high.", options: ["moral", "morale"], a: 1, exp: "'Morale' refers to the spirit, confidence, and enthusiasm of a group." },
    { t: 'mc', cat: 'Homophones', q: "Washington D.C. is the ____.", options: ["capital", "capitol"], a: 0, exp: "A 'capital' refers to the city itself, or uppercase letters, or money." },
    { t: 'mc', cat: 'Homophones', q: "The meeting is in the ____ building.", options: ["capital", "capitol"], a: 1, exp: "The 'capitol' (with an O) refers exclusively to the physical building where legislators meet." },
    { t: 'binary', cat: 'Homophones', q: "Please read aloud.", a: true, exp: "Correct. 'Aloud' means speaking so others can hear, whereas 'allowed' means permitted." },
    { t: 'binary', cat: 'Homophones', q: "He has bare feet.", a: true, exp: "Correct. 'Bare' means uncovered, while 'bear' refers to the animal or to carry a burden." },
    { t: 'binary', cat: 'Homophones', q: "I can't bare it anymore.", a: false, exp: "Use 'bear' when meaning to endure or carry a weight. 'Bare' means uncovered or naked." },
    { t: 'binary', cat: 'Homophones', q: "Hit the breaks!", a: false, exp: "Use 'brakes' for the device that stops a vehicle. 'Breaks' refers to shattering something or taking a pause." },
    { t: 'binary', cat: 'Homophones', q: "That is a nice cent.", a: false, exp: "A 'cent' is money. Use 'scent' for a smell, or 'sent' for the past tense of send." },
    { t: 'binary', cat: 'Homophones', q: "Bake with flower.", a: false, exp: "Use 'flour' for the ground grain used in baking. A 'flower' is the blooming part of a plant." },
    { t: 'binary', cat: 'Homophones', q: "Heal of foot.", a: false, exp: "The back of your foot is the 'heel'. 'Heal' means to recover from an injury." },
    { t: 'binary', cat: 'Homophones', q: "I no him well.", a: false, exp: "Use 'know' for having knowledge or familiarity. 'No' is the opposite of yes." },
    { t: 'binary', cat: 'Homophones', q: "Nice to meat you.", a: false, exp: "Use 'meet' when encountering someone. 'Meat' is animal flesh used for food." },
    { t: 'binary', cat: 'Homophones', q: "We one the game.", a: false, exp: "Use 'won' for the past tense of win. 'One' is the number." },
    { t: 'binary', cat: 'Homophones', q: "I ate a cinnamon role.", a: false, exp: "Use 'roll' for bread or the action of spinning. A 'role' is a part played by an actor or a function." },
    { t: 'binary', cat: 'Homophones', q: "This boat is for sail.", a: false, exp: "Use 'sale' for the exchange of goods for money. A 'sail' catches the wind on a boat." },
    { t: 'binary', cat: 'Homophones', q: "Walk up the stare case.", a: false, exp: "Use 'stair' for the steps you walk on. 'Stare' means to look at something intently." },
    { t: 'binary', cat: 'Homophones', q: "Read a fairy tail.", a: false, exp: "A 'tale' is a story. A 'tail' is the appendage at the back of an animal." },
    { t: 'binary', cat: 'Homophones', q: "It is a waist of time.", a: false, exp: "Use 'waste' for squandering something or for garbage. Your 'waist' is the middle of your body." },
    { t: 'binary', cat: 'Homophones', q: "Lose some wait.", a: false, exp: "Use 'weight' for how heavy something is. 'Wait' means to stay where you are or delay action." },
    { t: 'binary', cat: 'Homophones', q: "I saw him last weak.", a: false, exp: "Use 'week' for the seven-day period. 'Weak' means lacking physical strength." },
    { t: 'binary', cat: 'Homophones', q: "Where a hat.", a: false, exp: "Use 'wear' for putting on clothing. 'Where' asks for a location." },
    { t: 'binary', cat: 'Homophones', q: "Make a write turn.", a: false, exp: "Use 'right' for a direction or meaning correct. 'Write' means to form letters or words." }
];

// Generator to flesh out list to 150+ without bloating code size
// We create variations of common templates
const templates = [
    { t: 'binary', cat: 'Homophones', base: "They're going to the park.", a: true, exp: "'They're' is the contraction for 'They are'." },
    { t: 'binary', cat: 'Homophones', base: "Their going to the park.", a: false, exp: "Incorrect. 'Their' implies ownership. It should be 'They're' (They are)." },
    { t: 'binary', cat: 'Homophones', base: "There going to the park.", a: false, exp: "Incorrect. 'There' refers to a location. It should be 'They're' (They are)." },
    { t: 'binary', cat: 'Homophones', base: "The book is over there.", a: true, exp: "Correct. 'There' refers to a specific place or location." },
    { t: 'binary', cat: 'Homophones', base: "It is their book.", a: true, exp: "Correct. 'Their' is a possessive pronoun showing ownership of the book." },
    { t: 'mc', cat: 'Subject-Verb', q: "The group of students ___ loud.", options: ["is", "are"], a: 0, exp: "The subject is 'group' (singular), not 'students' (plural). Therefore, the group IS loud." },
    { t: 'mc', cat: 'Subject-Verb', q: "A bouquet of flowers ___ arrived.", options: ["has", "have"], a: 0, exp: "The subject is 'bouquet' (singular). The prepositional phrase 'of flowers' does not change the subject's number." },
    { t: 'mc', cat: 'Pronouns', q: "Him and I went.", options: ["Him and I", "He and I"], a: 1, exp: "Always use the subject case ('He') when they are the ones performing the action." },
    { t: 'mc', cat: 'Pronouns', q: "Give it to ___.", options: ["Steve and I", "Steve and me"], a: 1, exp: "Remove the other person to test it: You would say 'Give it to me', not 'Give it to I'." }
];

// Procedurally generate filler questions
const vocabVariations = [
    { s: "The dog", v: "runs" }, { s: "The cat", v: "runs" }, { s: "The team", v: "plays" }, 
    { s: "The jury", v: "votes" }, { s: "The family", v: "eats" }
];

const rawData = []; 
vocabVariations.forEach(v => {
    rawData.push({ t: 'binary', cat: 'Subject-Verb', q: `${v.s} ${v.v} fast.`, a: true, exp: "Singular subject takes singular verb." });
    rawData.push({ t: 'binary', cat: 'Subject-Verb', q: `${v.s} ${v.v.slice(0, -1)} fast.`, a: false, exp: "Singular subject requires 's' ending verb." });
});

// Final list compilation
const allQuestions = [...questionDB, ...templates, ...rawData];

/**
 * CONFETTI ENGINE (Vanilla JS)
 */
const confetti = {
    canvas: null,
    ctx: null,
    particles: [],
    active: false,
    init: function() {
        this.canvas = document.getElementById('confetti-canvas');
        if (!this.canvas) return; // Guard
        this.ctx = this.canvas.getContext('2d');
        
        this.resize();
        window.addEventListener('resize', () => this.resize());
        this.loop = this.loop.bind(this);
        // Do not start loop until trigger to save resources
    },
    resize: function() {
        if (!this.canvas) return;
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    },
    trigger: function() {
        if (!this.canvas) return;
        this.canvas.classList.remove('hidden'); // SHOW CANVAS
        this.active = true;
        
        const colors = ['#4f46e5', '#f59e0b', '#ef4444', '#10b981'];
        for(let i=0; i<100; i++) {
            this.particles.push({
                x: this.canvas.width / 2,
                y: this.canvas.height / 2,
                vx: (Math.random() - 0.5) * 15,
                vy: (Math.random() - 0.5) * 15,
                size: Math.random() * 8 + 2,
                color: colors[Math.floor(Math.random() * colors.length)],
                life: 100
            });
        }
        requestAnimationFrame(this.loop);
    },
    loop: function() {
        if (!this.ctx || !this.active) return;
        
        if (this.particles.length === 0) {
            this.active = false;
            this.canvas.classList.add('hidden'); // HIDE CANVAS
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            return;
        }
        
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        for(let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.2; // Gravity
            p.life--;
            
            this.ctx.fillStyle = p.color;
            this.ctx.globalAlpha = p.life / 100;
            this.ctx.fillRect(p.x, p.y, p.size, p.size);
            
            if(p.life <= 0) this.particles.splice(i, 1);
        }
        
        requestAnimationFrame(this.loop);
    },
    stop: function() {
        this.active = false;
        this.particles = [];
        if(this.canvas) {
            this.canvas.classList.add('hidden');
            if(this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
    }
};

/**
 * GAME LOGIC
 */
window.game = {
    state: {
        mode: 'standard',
        score: 0,
        lives: 3,
        streak: 0,
        maxStreak: 0,
        questions: [],
        currentQ: null,
        timer: null,
        timeLeft: 10,
        paused: false,
        bentzyTriggered: false,
        globalMuted: false,
        pendingMode: null,
        isAdmin: false,
        adminTestMode: false,
        count: 0,
        globalTimeLeft: 60,
        globalTimer: null,
        lastSavedDocId: null,
        userProfile: {
            username: 'Guest Player',
            avatar: '👤',
            avatarColor: 'bg-slate-200',
            publicTag: '',
            lastProfileChangeAt: null
        },
        savedUserProfile: {
            username: 'Guest Player',
            avatar: '👤',
            avatarColor: 'bg-slate-200',
            publicTag: '',
            lastProfileChangeAt: null
        }
    },

    init: function() {
        confetti.init();
        window.ui.showHome();
        window.ui.initInstallPrompt();
        window.ui.checkDisplayMode();
        this.initEventListeners();
        window.ui.initAccordion();
    },

    initEventListeners: function() {
        const startStd = document.getElementById('btn-start-standard');
        const startDl = document.getElementById('btn-start-deadline');
        const startBlitz = document.getElementById('btn-start-blitz');
        if (startStd) startStd.addEventListener('click', () => this.confirmMode('standard'));
        if (startDl) startDl.addEventListener('click', () => this.confirmMode('deadline'));
        if (startBlitz) startBlitz.addEventListener('click', () => this.confirmMode('blitz'));
    },

    toggleSoundMute: function() {
        this.state.globalMuted = !this.state.globalMuted;
        if (!this.state.globalMuted) {
            audio.init().catch(() => {});
        }
        window.ui.updateAudioToggle();
    },

    confirmMode: function(mode) {
        this.state.pendingMode = mode;
        const title = document.getElementById('mode-confirm-title');
        const desc = document.getElementById('mode-confirm-desc');
        const icon = document.getElementById('mode-confirm-icon');
        
        if (mode === 'standard') {
            if (title) title.innerText = 'Standard Mode';
            if (desc) desc.innerText = 'Relaxed pace. 3 lives. Build streaks in comfort.';
            if (icon) icon.innerText = '🎯';
        } else if (mode === 'deadline') {
            if (title) title.innerText = 'Deadline Mode';
            if (desc) desc.innerText = '10s timer per question. High stakes. Fast editing flow.';
            if (icon) icon.innerText = '⏳';
        } else if (mode === 'blitz') {
            if (title) title.innerText = 'Blitz Mode';
            if (desc) desc.innerText = '60 seconds global timer. Infinite lives. Test your speed.';
            if (icon) icon.innerText = '⚡';
        }
        window.ui.toggleModal('modal-mode-confirm', true);
    },

    startPendingMode: function() {
        window.ui.toggleModal('modal-mode-confirm', false);
        if (this.state.pendingMode) {
            this.start(this.state.pendingMode);
        }
    },

    start: function(mode) {
        audio.init().then(() => audio.click()).catch(() => {});
        
        // Fetch countdown elements
        const countdownScreen = document.getElementById('screen-countdown');
        const countdownNum = document.getElementById('countdown-number');
        
        // Safety Fallback (If DOM hasn't parsed the element for some reason)
        if (!countdownScreen || !countdownNum) {
            console.warn("Countdown UI missing, skipping to launch.");
            return this.launch(mode);
        }

        // Show Countdown
        countdownScreen.classList.remove('hidden');
        countdownScreen.classList.add('flex');
        
        let count = 3;
        countdownNum.innerText = count;
        audio.playTone(400, 'sine', 0.1); // Beep

        const interval = setInterval(() => {
            count--;
            if (count > 0) {
                countdownNum.innerText = count;
                // Trigger animation reset
                countdownNum.classList.remove('pulse-num');
                void countdownNum.offsetWidth;
                countdownNum.classList.add('pulse-num');
                audio.playTone(400, 'sine', 0.1); // Beep
            } else if (count === 0) {
                countdownNum.innerText = "EDIT!";
                audio.playTone(800, 'square', 0.2); // GO sound
            } else {
                clearInterval(interval);
                countdownScreen.classList.add('hidden');
                countdownScreen.classList.remove('flex');
                this.launch(mode); // Actual Start
            }
        }, 800); // Slightly faster than 1s for better feel
    },

    launch: function(mode) {
        // Reset State
        this.state.mode = mode;
        this.state.score = 0;
        this.state.lives = mode === 'blitz' ? '∞' : 3;
        this.state.streak = 0;
        this.state.maxStreak = 0;
        this.state.count = 0;
        this.state.paused = false;
        this.state.bentzyTriggered = false;
        this.state.globalTimeLeft = 60;
        this.state.lastSavedDocId = null;

        // Clean up confetti immediately
        confetti.stop();
        
        // Shuffle Questions
        this.state.questions = [...allQuestions];
        // True random shuffle (Fisher-Yates) to prevent repetitive questions at the start
        for (let i = this.state.questions.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.state.questions[i], this.state.questions[j]] = [this.state.questions[j], this.state.questions[i]];
        }
        
        // UI Reset
        window.ui.showScreen('screen-game');
        window.ui.updateStatus();
        document.getElementById('timer-bar-container').classList.toggle('hidden', mode !== 'deadline');
        
        // Setup Blitz Mode Timer
        if (mode === 'blitz') {
            const timerDisplay = document.getElementById('global-timer-display');
            if (timerDisplay) {
                timerDisplay.classList.remove('hidden');
                timerDisplay.innerText = '60s';
            }
            this.startBlitzTimer();
        } else {
            const timerDisplay = document.getElementById('global-timer-display');
            if (timerDisplay) timerDisplay.classList.add('hidden');
        }
        
        this.nextQuestion(true);
    },
    
    startBlitzTimer: function() {
        if (this.state.globalTimer) clearInterval(this.state.globalTimer);
        this.state.globalTimer = setInterval(() => {
            this.state.globalTimeLeft--;
            const timerDisplay = document.getElementById('global-timer-display');
            if (timerDisplay) {
                timerDisplay.innerText = this.state.globalTimeLeft + 's';
            }
            if (this.state.globalTimeLeft <= 0) {
                clearInterval(this.state.globalTimer);
                this.endGame(false, false);
            }
        }, 1000);
    },

    nextQuestion: function(isFirst = false) {
        this.stopTimer();

        // In Blitz mode, never end game from lives or questions
        if (this.state.mode !== 'blitz') {
            if (this.state.lives <= 0) {
                this.endGame(false, false);
                return;
            }

            if (this.state.questions.length === 0) {
                this.endGame(false, true); // Win
                return;
            }
        }

        this.state.currentQ = this.state.questions.pop();
        window.ui.renderQuestion(this.state.currentQ);
        window.ui.updateProgressBar(this.state.count); 

        if (this.state.mode === 'deadline') {
            this.startTimer();
        }
    },

    handleAnswer: function(userSelection) {
        this.stopTimer();
        
        const q = this.state.currentQ;
        let isCorrect = false;
        this.state.count++;

        if (q.t === 'binary') {
            isCorrect = (userSelection === q.a);
        } else {
            isCorrect = (userSelection === q.a);
        }

        // --- SILENT ANALYTICS TRACKING ---
        // Tracks performance without saving if you are in Admin Test Mode
        if (window.analytics && window.logEvent && !this.state.adminTestMode) {
            try {
                window.logEvent(window.analytics, 'question_answered', {
                    question_category: q.cat,
                    is_correct: isCorrect ? 'true' : 'false',
                    game_mode: this.state.mode
                });
            } catch (e) {
                // Fail silently so it never interrupts gameplay
            }
        }

        if (isCorrect) {
            this.handleSuccess();
        } else {
            this.handleFail();
        }
        
        window.ui.showFeedback(isCorrect, q.exp);
    },

    handleSuccess: function() {
        audio.success();
        this.state.streak++;
        
        if (this.state.streak > this.state.maxStreak) {
            this.state.maxStreak = this.state.streak;
        }

        let points = 1; 
        if (this.state.streak >= 10) points = 5; 
        else if (this.state.streak >= 3) points = 2; 
        
        this.state.score += points;
        
        if (this.state.score >= 75 && !this.state.bentzyTriggered) {
            this.triggerEasterEgg();
        }

        window.ui.updateStatus();
    },

    handleFail: function() {
        audio.fail();
        this.state.streak = 0;
        
        // In Blitz mode, do not deduct lives
        if (this.state.mode !== 'blitz') {
            this.state.lives--;
        }
        
        const card = document.getElementById('question-card');
        card.classList.remove('shake');
        void card.offsetWidth; 
        card.classList.add('shake');

        window.ui.updateStatus();
    },

    startTimer: function(remainingSeconds = 10) {
        this.stopTimer();
        this.state.timeLeft = Math.max(0, Math.min(remainingSeconds, 10));
        const bar = document.getElementById('timer-bar');
        if(bar) {
            const percent = (this.state.timeLeft / 10) * 100;
            bar.style.transition = 'none';
            bar.style.width = percent + '%';

            setTimeout(() => {
                bar.style.transition = `width ${this.state.timeLeft}s linear`;
                bar.style.width = '0%';
            }, 50);
        }

        this.state.timer = setInterval(() => {
            this.state.timeLeft--;
            if (this.state.timeLeft <= 0) {
                this.stopTimer();
                this.handleAnswer('TIMEOUT'); 
            }
        }, 1000);
    },

    stopTimer: function() {
        clearInterval(this.state.timer);
        this.state.timer = null;
        const bar = document.getElementById('timer-bar');
        if(bar) bar.style.transition = 'none';
    },

    togglePause: function() {
        if (!this.state.paused) {
            this.state.paused = true;
            this.stopTimer();
            window.ui.toggleModal('modal-pause', true);
            return;
        }

        this.state.paused = false;
        window.ui.toggleModal('modal-pause', false);
        if (this.state.mode === 'deadline' && this.state.timeLeft > 0) {
            this.startTimer(this.state.timeLeft);
        }
    },

    endGame: function(quit = false, win = false) {
        this.stopTimer();
        
        // Clear Blitz mode global timer
        if (this.state.globalTimer) {
            clearInterval(this.state.globalTimer);
            this.state.globalTimer = null;
        }
        
        // Hide global timer display
        const timerDisplay = document.getElementById('global-timer-display');
        if (timerDisplay) timerDisplay.classList.add('hidden');
        
        // FIX: Close pause modal explicitly in case we quit from there
        window.ui.toggleModal('modal-pause', false);

        // Update DOM immediately before any network calls
        document.getElementById('final-score').innerText = this.state.score;
        document.getElementById('final-streak').innerText = this.state.maxStreak;
        document.getElementById('final-count').innerText = `${this.state.count}`;

        // Show game over screen synchronously
        window.ui.showGameOver(win);
        if(win) confetti.trigger();

        // Isolate network calls with defensive programming
        try {
            // Save game to Firestore if user is authenticated and score > 0
            const user = auth.currentUser;
            if (user && !quit && this.state.score > 0 && !this.state.adminTestMode) {
                const gameData = {
                    uid: user.uid,
                    name: user.displayName || 'Anonymous',
                    photoURL: user.photoURL || 'https://www.gravatar.com/avatar/?d=mp',
                    score: this.state.score,
                    maxStreak: this.state.maxStreak,
                    mode: this.state.mode,
                    timestamp: new Date(),
                    username: window.game.state.userProfile.username,
                    avatar: window.game.state.userProfile.avatar,
                    avatarColor: window.game.state.userProfile.avatarColor,
                    publicTag: window.game.state.userProfile.publicTag || ''
                };
                addDoc(collection(db, 'games'), gameData).then((docRef) => {
                    this.state.lastSavedDocId = docRef.id;
                }).catch((error) => {
                    console.error('Firebase save error:', error);
                });
            }

            // Comparative ranking
            const currentScore = this.state.score;
            const currentMode = this.state.mode;
            const q = query(collection(db, 'games'), where('score', '>', currentScore), where('mode', '==', currentMode));
            getCountFromServer(q).then((snapshot) => {
                const rank = snapshot.data().count + 1;
                const rankEl = document.getElementById('endgame-comparative-rank');
                rankEl.innerText = `You placed #${rank} globally this round!`;
                rankEl.classList.remove('hidden');
            }).catch((error) => {
                console.error('Comparative ranking query error:', error);
                // Leave rank text hidden on error
            });

            // Analytics
            if (window.analytics && window.logEvent) {
                window.logEvent(window.analytics, 'level_end', {
                    game_mode: window.game.state.mode,
                    final_score: window.game.state.score,
                    max_streak: window.game.state.maxStreak || 0
                });
            }
        } catch (error) {
            console.error("Firebase/Analytics Error during endgame:", error);
        }
    },

    triggerEasterEgg: function() {
        this.state.bentzyTriggered = true;
        audio.bentzy();
        const toast = document.getElementById('toast');
        toast.style.opacity = '1';
        toast.style.transform = 'translate(-50%, 0)'; 
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translate(-50%, -20px)';
        }, 3000);
    }
};

/**
 * UI CONTROLLER
 */
window.ui = {
    screens: ['screen-home', 'screen-game', 'screen-gameover'],
    returnToConfirm: false,

    initTheme: function() {
        const storedTheme = localStorage.getItem('editor-theme');
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const isDark = storedTheme ? storedTheme === 'dark' : prefersDark;
        document.documentElement.classList.toggle('dark', isDark);
    },
    
    showScreen: function(id) {
        this.screens.forEach(s => document.getElementById(s).classList.add('hidden'));
        document.getElementById(id).classList.remove('hidden');
        document.getElementById(id).classList.add('flex');
    },

    showHome: function() {
        this.showScreen('screen-home');
        this.updateAudioToggle();
    },

    openSidebar: function() {
        const sidebar = document.getElementById('user-sidebar');
        if (sidebar) sidebar.classList.remove('-translate-x-full');
    },

    closeSidebar: function() {
        const sidebar = document.getElementById('user-sidebar');
        if (sidebar) sidebar.classList.add('-translate-x-full');
    },

    toggleDarkMode: function() {
        const isDark = document.documentElement.classList.toggle('dark');
        localStorage.setItem('editor-theme', isDark ? 'dark' : 'light');
    },

    toggleModal: function(id, forceState) {
        const el = document.getElementById(id);
        const isHidden = el.classList.contains('hidden');
        const show = forceState !== undefined ? forceState : isHidden;
        
        if (show) {
            el.classList.remove('hidden');
            if (id === 'modal-profile') {
                const livePreview = document.getElementById('modal-live-preview');
                const usernameInput = document.getElementById('profile-username-input');
                if (livePreview) {
                    livePreview.innerText = window.game.state.userProfile.avatar;
                    livePreview.className = `w-24 h-24 rounded-full flex items-center justify-center text-5xl shadow-lg transition-colors duration-200 ${window.game.state.userProfile.avatarColor}`;
                }
                if (usernameInput) {
                    usernameInput.value = window.game.state.savedUserProfile?.username || window.game.state.userProfile.username || '';
                }
            }
        } else {
            el.classList.add('hidden');
        }
    },

    renderHowTo: function(mode) {
        const container = document.getElementById('how-to-content');
        if (!container) return;

        const colors = {
            indigo: "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-300",
            amber: "bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-300",
            red: "bg-red-100 text-red-600 dark:bg-red-500/20 dark:text-red-300",
            orange: "bg-orange-100 text-orange-600 dark:bg-orange-500/20 dark:text-orange-300"
        };

        let rules = [];

        if (mode === 'general') {
            rules.push({ title: "Review the Manuscript", desc: "Read the sentence on the yellow paper card.", color: "indigo" });
            rules.push({ title: "Make the Call", desc: "Select the option that fixes the error, or Approve/Reject if asked.", color: "indigo" });
            rules.push({ title: "Score & Streaks", desc: "Base: 1 pt. Streak 3+: 2x points. Streak 10+: 5x points.", color: "amber" });
        } else if (mode === 'deadline') {
            rules.push({ title: "10-Second Timer", desc: "You have exactly 10 seconds per question. Don't let it run out!", color: "red" });
            rules.push({ title: "3 Lives", desc: "Three mistakes or timeouts and the game is over.", color: "orange" });
        } else if (mode === 'blitz') {
            rules.push({ title: "60-Second Rush", desc: "You have exactly one minute to answer as many as possible.", color: "orange" });
            rules.push({ title: "Infinite Lives", desc: "Mistakes won't end the game, but they will reset your streak.", color: "red" });
            rules.push({ title: "Pro Tip", desc: "Remember, streaks multiply your points! It pays to be accurate, not just fast.", color: "amber" });
        } else if (mode === 'standard') {
            rules.push({ title: "No Time Limit", desc: "Take your time. Read carefully and make the right call.", color: "indigo" });
            rules.push({ title: "3 Lives", desc: "Three strikes and the game is over.", color: "red" });
        }

        container.innerHTML = rules.map((r, i) => `
            <div class="flex items-start gap-3">
                <div class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${colors[r.color]}">${i + 1}</div>
                <div>
                    <p class="font-bold text-slate-800 dark:text-slate-100">${r.title}</p>
                    <p class="text-sm text-slate-600 mt-1 dark:text-slate-300">${r.desc}</p>
                </div>
            </div>
        `).join('');
    },

    openHowToGeneral: function() {
        this.renderHowTo('general'); // Show universal rules from main menu
        this.toggleModal('modal-how-to', true);
    },

    openHowToFromConfirm: function() {
        this.returnToConfirm = true;
        this.toggleModal('modal-mode-confirm', false);
        this.renderHowTo(window.game.state.pendingMode);
        this.toggleModal('modal-how-to', true);
    },

    closeHowTo: function() {
        this.toggleModal('modal-how-to', false);
        if (this.returnToConfirm) {
            this.toggleModal('modal-mode-confirm', true);
            this.returnToConfirm = false;
        }
    },

    updateStatus: function() {
        document.getElementById('score-display').innerText = window.game.state.score + " pts";
        document.getElementById('lives-display').innerText = window.game.state.lives;
        
        const badge = document.getElementById('streak-badge');
        const blitzDisplay = document.getElementById('blitz-streak-display');
        const blitzCount = document.getElementById('blitz-streak-count');
        const streakCount = document.getElementById('streak-count');
        const multBadge = document.getElementById('streak-multiplier');
        const blitzMult = document.getElementById('blitz-streak-multiplier');
        
        const currentStreak = window.game.state.streak;
        if (streakCount) streakCount.innerText = currentStreak;
        
        let multiplier = 1;
        if (currentStreak >= 10) multiplier = 5;
        else if (currentStreak >= 3) multiplier = 2;
        
        if (multBadge) {
            if (multiplier > 1) {
                multBadge.innerText = `${multiplier}x Pts`;
                multBadge.classList.remove('hidden');
            } else {
                multBadge.classList.add('hidden');
            }
        }
        
        if (blitzMult) {
            if (multiplier > 1) {
                blitzMult.innerText = `${multiplier}x Pts`;
                blitzMult.classList.remove('hidden');
            } else {
                blitzMult.classList.add('hidden');
            }
        }
        
        if (window.game.state.mode === 'blitz') {
            badge.classList.add('hidden');
            if (blitzDisplay && blitzCount) {
                blitzDisplay.classList.remove('hidden');
                blitzCount.innerText = window.game.state.streak;
                blitzDisplay.style.transform = 'scale(1.1)';
                setTimeout(() => { blitzDisplay.style.transform = 'scale(1)'; }, 150);
            }
        } else {
            badge.classList.remove('hidden');
            if (blitzDisplay) blitzDisplay.classList.add('hidden');
            if (window.game.state.streak >= 3) badge.classList.remove('opacity-0');
            else badge.classList.add('opacity-0');
        }
        
        document.getElementById('game-mode-display').innerText = window.game.state.mode;
        this.updateAudioToggle();
    },

    updateAudioToggle: function() {
        const iconHome = document.getElementById('audio-toggle-icon-home');
        const iconGame = document.getElementById('audio-toggle-icon-game');
        const muted = window.game.state.globalMuted;
        
        if (iconHome) {
            if (muted) {
                iconHome.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6"><path stroke-linecap="round" stroke-linejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" /></svg>';
            } else {
                iconHome.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6"><path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" /></svg>';
            }
        }
        if (iconGame) {
            if (muted) {
                iconGame.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6"><path stroke-linecap="round" stroke-linejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" /></svg>';
            } else {
                iconGame.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6"><path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" /></svg>';
            }
        }
    },

    handleLeaderboardButton: async function() {
        try {
            await this.showLeaderboard();
        } catch (error) {
            console.error("Leaderboard crash:", error);
        }
    },

    getQuestionTypeDetail: function(q) {
        if (!q) return questionTypeDetails.Other;
        return questionTypeDetails[q.cat] || questionTypeDetails.Other;
    },

    toggleQuestionTypeDetail: function() {
        const detail = document.getElementById('feedback-detail');
        const btn = document.getElementById('btn-learn-more');
        if (!detail) return;
        if (!detail.classList.contains('hidden')) {
            detail.classList.add('hidden');
            if (btn) btn.innerText = 'Learn more about this concept';
            return;
        }
        detail.innerText = this.getQuestionTypeDetail(window.game.state.currentQ);
        detail.classList.remove('hidden');
        if (btn) btn.innerText = 'Hide detail';
    },

    renderQuestion: function(q) {
        document.getElementById('feedback-inline').classList.add('hidden');
        document.getElementById('feedback-detail').classList.add('hidden');
        document.getElementById('btn-next').classList.add('hidden');
        
        document.getElementById('q-category').innerText = q.cat;
        
        // --- SMART PROMPT LOGIC ---
        const promptEl = document.getElementById('q-prompt');
        let promptText = "";

        if (q.t === 'binary') {
            if (q.cat === 'Spelling') promptText = "Is this spelled correctly?";
            else if (q.cat === 'Punctuation') promptText = "Is the punctuation correct?";
            else if (q.cat === 'Capitalization') promptText = "Is the capitalization correct?";
            else if (q.cat === 'Hyphens') promptText = "Is the hyphenation correct?";
            else if (q.cat === 'Homophones') promptText = "Is the correct word used?";
            else if (q.cat === 'Agreement' || q.cat === 'Subject-Verb') promptText = "Is the verb agreement correct?";
            else promptText = "Is this sentence correct?";
            
            promptEl.innerText = promptText;
            promptEl.classList.remove('hidden');
        } else {
            promptEl.classList.add('hidden');
        }

        document.getElementById('q-text').innerText = q.q || q.base;

        const binCtrl = document.getElementById('controls-binary');
        const mcCtrl = document.getElementById('controls-mc');
        
        mcCtrl.innerHTML = ''; 

        if (q.t === 'binary') {
            binCtrl.classList.remove('hidden');
            binCtrl.classList.add('grid');
            mcCtrl.classList.add('hidden');
        } else {
            binCtrl.classList.add('hidden');
            binCtrl.classList.remove('grid');
            mcCtrl.classList.remove('hidden');
            
            q.options.forEach((opt, idx) => {
                const btn = document.createElement('button');
                btn.className = "w-full bg-white border border-indigo-100 hover:border-indigo-500 hover:text-indigo-700 text-slate-700 font-bold py-4 px-6 rounded-2xl shadow-sm transition-all text-left text-lg active:bg-indigo-50 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100 dark:hover:border-indigo-400 dark:hover:text-indigo-300 dark:active:bg-slate-800";
                btn.innerText = opt;
                btn.onclick = () => window.game.handleAnswer(idx);
                mcCtrl.appendChild(btn);
            });
        }
    },

    showFeedback: function(isCorrect, explanation) {
        document.getElementById('controls-binary').classList.add('hidden');
        document.getElementById('controls-binary').classList.remove('grid');
        document.getElementById('controls-mc').classList.add('hidden');
        
        const fb = document.getElementById('feedback-inline');
        fb.innerHTML = isCorrect ? "✓ Correct!" : "✕ Incorrect";
        fb.className = isCorrect ? "block text-center font-bold mt-4 text-green-600 text-xl pop-in" : "block text-center font-bold mt-4 text-red-600 text-xl pop-in";
        
        const txt = document.getElementById('q-text');
        const btn = document.getElementById('btn-next');
        
        if (window.game.state.mode !== 'blitz') {
            txt.innerHTML += `<br><br><span class='text-sm text-slate-500 font-sans border-t pt-2 block dark:text-slate-400 dark:border-slate-700'>${explanation}</span>`;
            
            const btnLearn = document.createElement('button');
            btnLearn.id = 'btn-learn-more';
            btnLearn.className = 'mt-3 mx-auto block w-full max-w-xs px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 transition';
            btnLearn.innerText = 'Learn more about this concept';
            btnLearn.onclick = () => window.ui.toggleQuestionTypeDetail();
            fb.appendChild(btnLearn);

            document.getElementById('feedback-detail').classList.add('hidden');
            btn.classList.remove('hidden');
        } else {
            btn.classList.add('hidden');
            setTimeout(() => {
                if (window.game.state.mode === 'blitz' && window.game.state.globalTimeLeft > 0 && !window.game.state.paused) {
                    window.game.nextQuestion();
                }
            }, 500); // Half-second pause to see the result
        }
    },

    updateProgressBar: function(current) {
        // current is number of questions PLAYED
        const pct = Math.min((current / allQuestions.length) * 100, 100);
        document.getElementById('progress-bar').style.width = pct + "%";
    },

    showGameOver: function(win) {
        this.showScreen('screen-gameover');
        
        // Dynamic Victory Logic
        const title = document.getElementById('gameover-title');
        const msg = document.getElementById('gameover-msg');
        
        if (win) {
            if (title) {
                title.innerText = "Edition Perfect!";
                title.className = "text-3xl font-bold text-green-600 dark:text-green-400";
            }
            if (msg) {
                msg.innerText = "The manuscript is flawless. You are a master editor.";
            }
        } else {
            if (title) {
                title.innerText = "Final Edit";
                title.className = "text-3xl font-bold text-slate-900 dark:text-slate-100";
            }
            if (msg) {
                msg.innerText = "Good effort, but the printing press waits for no one.";
            }
        }
        
        const scoreEl = document.getElementById('final-score');
        if (scoreEl) {
            scoreEl.innerText = window.game.state.score;
        }
        const streakEl = document.getElementById('final-streak');
        if (streakEl) {
            streakEl.innerText = window.game.state.maxStreak;
        }
        const countEl = document.getElementById('final-count');
        if (countEl) {
            countEl.innerText = `${window.game.state.count}`;
        }

        // Show guest login prompt if unregistered and scored > 0
        const guestPrompt = document.getElementById('gameover-guest-prompt');
        if (guestPrompt) {
            if (!window.game.state.user && window.game.state.score > 0 && !window.game.state.adminTestMode) {
                guestPrompt.classList.remove('hidden');
            } else {
                guestPrompt.classList.add('hidden');
            }
        }

        // Show install prompt gently after gameplay finishes (delayed to wait for endgame animations)
        setTimeout(() => {
            this.showInstallToastIfNeeded();
        }, 3500);
    },

    deleteScore: async function(docId, mode, lockMode) {
        if (!window.game.state.isAdmin) return;
        if (!confirm('Are you sure you want to delete this score? This cannot be undone.')) return;
        
        try {
            await deleteDoc(doc(db, 'games', docId));
            this.showLeaderboard(mode, lockMode); // Refresh leaderboard instantly
        } catch (error) {
            console.error('Error deleting score:', error);
            alert('Failed to delete score.');
        }
    },

    showLeaderboard: async function(mode = 'standard', lockMode = false) {
        this.toggleModal('leaderboard-modal', true);
        const listEl = document.getElementById('leaderboard-list');
        listEl.innerHTML = `
            <div class="space-y-3">
                <div class="flex items-center gap-4 p-4 bg-slate-50 rounded-lg animate-pulse dark:bg-slate-800/80">
                    <div class="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700"></div>
                    <div class="w-10 h-10 rounded-full bg-slate-200 dark:bg-slate-700"></div>
                    <div class="flex-1 space-y-2">
                        <div class="h-4 w-28 rounded bg-slate-200 dark:bg-slate-700"></div>
                    </div>
                    <div class="h-5 w-20 rounded bg-slate-200 dark:bg-slate-700"></div>
                </div>
                <div class="flex items-center gap-4 p-4 bg-slate-50 rounded-lg animate-pulse dark:bg-slate-800/80">
                    <div class="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700"></div>
                    <div class="w-10 h-10 rounded-full bg-slate-200 dark:bg-slate-700"></div>
                    <div class="flex-1 space-y-2">
                        <div class="h-4 w-24 rounded bg-slate-200 dark:bg-slate-700"></div>
                    </div>
                    <div class="h-5 w-16 rounded bg-slate-200 dark:bg-slate-700"></div>
                </div>
                <div class="flex items-center gap-4 p-4 bg-slate-50 rounded-lg animate-pulse dark:bg-slate-800/80">
                    <div class="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700"></div>
                    <div class="w-10 h-10 rounded-full bg-slate-200 dark:bg-slate-700"></div>
                    <div class="flex-1 space-y-2">
                        <div class="h-4 w-32 rounded bg-slate-200 dark:bg-slate-700"></div>
                    </div>
                    <div class="h-5 w-20 rounded bg-slate-200 dark:bg-slate-700"></div>
                </div>
                <div class="flex items-center gap-4 p-4 bg-slate-50 rounded-lg animate-pulse dark:bg-slate-800/80">
                    <div class="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700"></div>
                    <div class="w-10 h-10 rounded-full bg-slate-200 dark:bg-slate-700"></div>
                    <div class="flex-1 space-y-2">
                        <div class="h-4 w-24 rounded bg-slate-200 dark:bg-slate-700"></div>
                    </div>
                    <div class="h-5 w-20 rounded bg-slate-200 dark:bg-slate-700"></div>
                </div>
                <div class="flex items-center gap-4 p-4 bg-slate-50 rounded-lg animate-pulse dark:bg-slate-800/80">
                    <div class="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700"></div>
                    <div class="w-10 h-10 rounded-full bg-slate-200 dark:bg-slate-700"></div>
                    <div class="flex-1 space-y-2">
                        <div class="h-4 w-28 rounded bg-slate-200 dark:bg-slate-700"></div>
                    </div>
                    <div class="h-5 w-16 rounded bg-slate-200 dark:bg-slate-700"></div>
                </div>
            </div>
        `;

        // Update active main tab styling
        const tabs = ['standard', 'deadline', 'blitz'];
        tabs.forEach(tab => {
            const tabBtn = document.getElementById(`lb-tab-${tab}`);
            if (tabBtn) {
                if (tab === mode) {
                    tabBtn.className = 'px-3 py-1 rounded-full text-xs font-bold transition-all bg-indigo-600 text-white shadow-sm shadow-indigo-500/20';
                } else {
                    tabBtn.className = 'px-3 py-1 rounded-full text-xs font-bold transition-all bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700';
                }
            }
        });

        // Handle tab visibility for endgame
        const tabNav = document.getElementById('leaderboard-tab-nav');
        if (tabNav) {
            if (lockMode) tabNav.classList.add('hidden');
            else tabNav.classList.remove('hidden');
        }

        try {
            let q;
            let labelSuffix = ' pts';

            if (mode === 'standard') {
                q = query(collection(db, 'games'), where('mode', '==', 'standard'), orderBy('score', 'desc'), limit(10));
            } else if (mode === 'deadline') {
                q = query(collection(db, 'games'), where('mode', '==', 'deadline'), orderBy('score', 'desc'), limit(10));
            } else if (mode === 'blitz') {
                q = query(collection(db, 'games'), where('mode', '==', 'blitz'), orderBy('score', 'desc'), limit(10));
            }

            const querySnapshot = await getDocs(q);
            
            let html = '<div class="space-y-3">';
            let rank = 1;
            let userInTop10 = false;
            let currentRunInTop10 = false;
            
            querySnapshot.forEach((doc) => {
                const data = doc.data();
                if (window.game.state.user && data.uid === window.game.state.user.uid) {
                    userInTop10 = true;
                }
                const isCurrentRun = window.game.state.lastSavedDocId && doc.id === window.game.state.lastSavedDocId;
                if (isCurrentRun) currentRunInTop10 = true;
                
                const playerName = data.username || data.displayName || "Anonymous Editor";
                const playerAvatar = data.avatar || "👤";
                const playerBg = data.avatarColor || "bg-gray-200";
                const playerTag = data.publicTag || '';
                const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '🏅';
                const displayValue = data.score;
                const displayIcon = '';
                
                const containerClasses = isCurrentRun
                    ? "flex items-center gap-4 p-4 rounded-lg bg-indigo-50 border border-indigo-200 shadow-md animate-pulse dark:bg-indigo-900/40 dark:border-indigo-500/50"
                    : "flex items-center gap-4 p-4 bg-slate-50 rounded-lg dark:bg-slate-800/80";
                const badgeHtml = isCurrentRun 
                    ? `<span class="ml-2 px-1.5 py-0.5 rounded-md text-[10px] font-extrabold bg-indigo-600 text-white uppercase tracking-wider shadow-sm">Just Now</span>` 
                    : '';
                    
                const nameColor = isCurrentRun ? "text-indigo-900 dark:text-indigo-50" : "text-slate-900 dark:text-slate-100";
                const tagColor = isCurrentRun ? "text-indigo-500 dark:text-indigo-300" : "text-slate-400 dark:text-slate-500";
                const scoreColor = isCurrentRun ? "text-indigo-700 dark:text-indigo-200" : "text-indigo-600 dark:text-indigo-400";
                const rankClass = isCurrentRun ? "bg-indigo-200 text-indigo-800 dark:bg-indigo-500/50 dark:text-indigo-100" : "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-300";

                html += `
                    <div class="${containerClasses}">
                        <div class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${rankClass}">${rank}</div>
                        <div class="w-10 h-10 rounded-full flex items-center justify-center text-lg ${playerBg}">${playerAvatar}</div>
                        <div class="flex-1 min-w-0">
                            <p class="font-bold truncate flex items-center ${nameColor}">${playerName}${badgeHtml}</p>
                            ${playerTag ? `<p class="text-xs font-semibold uppercase tracking-[0.18em] ${tagColor}">${playerTag}</p>` : ''}
                        </div>
                        <div class="flex items-center gap-2">
                            <span class="text-2xl">${medal}</span>
                            <span class="font-bold ${scoreColor}">${displayIcon} ${displayValue}${labelSuffix}</span>
                            ${window.game.state.isAdmin ? `<button onclick="window.ui.deleteScore('${doc.id}', '${mode}', ${lockMode})" class="ml-2 opacity-50 hover:opacity-100 text-red-500 hover:text-red-700 transition-opacity p-1" title="Delete Score">
                                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                            </button>` : ''}
                        </div>
                    </div>
                `;
                rank++;
            });

        // Handle the bottom pinned rank
        if (window.game.state.user) {
            let bottomPinData = null;
            let showBottomPin = false;

            if (lockMode && window.game.state.lastSavedDocId) {
                // Endgame Leaderboard: Show the CURRENT run's rank, ignoring all-time high score
                if (!currentRunInTop10) {
                    showBottomPin = true;
                    bottomPinData = {
                        score: window.game.state.score,
                        username: window.game.state.userProfile.username,
                        avatar: window.game.state.userProfile.avatar,
                        avatarColor: window.game.state.userProfile.avatarColor,
                        publicTag: window.game.state.userProfile.publicTag || '',
                        isCurrentRun: true
                    };
                }
            } else if (!userInTop10) {
                // Main Menu: Show all-time personal best for this mode
                try {
                    // Local filter method to bypass Firebase composite index requirements
                    const userQ = query(collection(db, 'games'), where('uid', '==', window.game.state.user.uid));
                    const userSnapshot = await getDocs(userQ);
                    
                    let bestGameData = null;
                    userSnapshot.forEach(d => {
                        const game = d.data();
                        if (game.mode === mode) {
                            if (!bestGameData || game.score > bestGameData.score) {
                                bestGameData = game;
                            }
                        }
                    });
                    
                    if (bestGameData) {
                        showBottomPin = true;
                        bottomPinData = bestGameData;
                        bottomPinData.isCurrentRun = false;
                    }
                } catch (err) {
                    console.error("Error fetching user's score for leaderboard", err);
                }
            }

            if (showBottomPin && bottomPinData) {
                try {
                    // Calculate exact global rank
                    const rankQ = query(collection(db, 'games'), where('mode', '==', mode), where('score', '>', bottomPinData.score));
                    const rankSnap = await getCountFromServer(rankQ);
                    const userRank = rankSnap.data().count + 1;

                    const playerName = bottomPinData.username || bottomPinData.displayName || "Anonymous Editor";
                    const playerAvatar = bottomPinData.avatar || "👤";
                    const playerBg = bottomPinData.avatarColor || "bg-gray-200";
                    const playerTag = bottomPinData.publicTag || '';
                    const displayValue = bottomPinData.score;
                    
                    const containerClasses = bottomPinData.isCurrentRun
                        ? "flex items-center gap-4 p-4 rounded-lg bg-indigo-50 border border-indigo-200 shadow-md animate-pulse dark:bg-indigo-900/40 dark:border-indigo-500/50"
                        : "flex items-center gap-4 p-4 rounded-lg bg-indigo-50 border border-indigo-200 shadow-md dark:bg-indigo-900/40 dark:border-indigo-500/50";
                        
                    const badgeHtml = bottomPinData.isCurrentRun 
                        ? `<span class="ml-2 px-1.5 py-0.5 rounded-md text-[10px] font-extrabold bg-indigo-600 text-white uppercase tracking-wider shadow-sm">Just Now</span>` 
                        : `<span class="ml-2 px-1.5 py-0.5 rounded-md text-[10px] font-extrabold bg-indigo-600 text-white uppercase tracking-wider shadow-sm">You</span>`;

                    html += `
                        <div class="flex justify-center py-1">
                            <span class="text-slate-300 dark:text-slate-600 font-black tracking-widest">•••</span>
                        </div>
                        <div class="${containerClasses}">
                            <div class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm bg-indigo-200 text-indigo-800 dark:bg-indigo-500/50 dark:text-indigo-100">${userRank}</div>
                            <div class="w-10 h-10 rounded-full flex items-center justify-center text-lg ${playerBg}">${playerAvatar}</div>
                            <div class="flex-1 min-w-0">
                                <p class="font-bold truncate flex items-center text-indigo-900 dark:text-indigo-50">${playerName}${badgeHtml}</p>
                                ${playerTag ? `<p class="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-500 dark:text-indigo-300">${playerTag}</p>` : ''}
                            </div>
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-indigo-700 dark:text-indigo-200">${displayValue}${labelSuffix}</span>
                            </div>
                        </div>
                    `;
                } catch (err) {
                    console.error("Error fetching rank", err);
                }
            }
        }

            if (querySnapshot.empty) {
                html = `
                    <div class="flex h-full min-h-full flex-col items-center justify-center rounded-xl bg-slate-50 px-6 text-center dark:bg-slate-800/70">
                        <p class="text-lg font-semibold text-slate-700 dark:text-slate-100">No games yet.</p>
                        <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">Be the first to put a score on the board.</p>
                    </div>
                `;
            } else {
                html += '</div>';
            }

            listEl.innerHTML = html;
        } catch (error) {
            console.error('Error fetching leaderboard:', error);
            listEl.innerHTML = `
                <div class="flex h-full min-h-full flex-col items-center justify-center rounded-xl bg-red-50 px-6 text-center dark:bg-red-950/40">
                    <p class="text-base font-semibold text-red-600">Failed to load leaderboard.</p>
                    <p class="mt-2 text-sm text-red-500 dark:text-red-300">Try again in a moment.</p>
                </div>
            `;
        }
    },

    initInstallPrompt: function() {
        const toast = document.getElementById('install-toast');
        const closeBtn = document.getElementById('close-install-toast');
        const installBtn = document.getElementById('install-btn');

        if (!toast || !closeBtn || !installBtn) return;

        // Android Logic - Capture prompt, don't show UI immediately
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            window.deferredPrompt = e;
        });

        // Install Button Click (Toast)
        installBtn.addEventListener('click', () => {
            if (window.deferredPrompt) {
                window.deferredPrompt.prompt();
                window.deferredPrompt.userChoice.then((choiceResult) => {
                    if (choiceResult.outcome === 'accepted') {
                        console.log('User accepted the install prompt');
                    } else {
                        console.log('User dismissed the install prompt');
                    }
                    window.deferredPrompt = null;
                });
            }
            localStorage.setItem('hasSeenInstallPrompt', 'true');
            toast.classList.add('hidden');
        });

        // Close Button Click
        closeBtn.addEventListener('click', () => {
            localStorage.setItem('hasSeenInstallPrompt', 'true');
            toast.classList.add('hidden');
        });
    },

    showInstallToastIfNeeded: function() {
        // Gatekeeper: Check if already seen, in standalone mode, or not mobile
        const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
        if (localStorage.getItem('hasSeenInstallPrompt') || isStandalone || !isMobile) {
            return;
        }

        const toast = document.getElementById('install-toast');
        const installBtn = document.getElementById('install-btn');
        const instructions = document.getElementById('install-instructions');
        
        if (!toast || !instructions) return;

        const isIOS = /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());
        
        if (isIOS) {
            toast.classList.remove('hidden');
            instructions.innerText = "To install: tap the Share icon at the bottom of Safari and select 'Add to Home Screen'.";
            if (installBtn) installBtn.classList.add('hidden');
        } else if (window.deferredPrompt) {
            toast.classList.remove('hidden');
            instructions.innerText = 'Get the full-screen app experience!';
            if (installBtn) installBtn.classList.remove('hidden');
        }
    },

    checkDisplayMode: function() {
        // Check if app is running in standalone mode (PWA installed)
        const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
        const sidebarInstallBtn = document.getElementById('sidebar-install-btn');

        if (!sidebarInstallBtn) return;

        // Show button ONLY if NOT in standalone mode AND device is mobile
        if (!isStandalone && isMobile) {
            sidebarInstallBtn.classList.remove('hidden');
        } else {
            sidebarInstallBtn.classList.add('hidden');
        }
    },

    handleSidebarInstall: function() {
        const toast = document.getElementById('install-toast');
        const instructions = document.getElementById('install-instructions');
        const isIOS = /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase());

        if (isIOS) {
            // iOS: Show the install toast with instructions
            if (toast) {
                toast.classList.remove('hidden');
                if (instructions) {
                    instructions.innerText = "To install: tap the Share icon at the bottom of Safari and select 'Add to Home Screen'.";
                }
            }
            // Close sidebar so user can see the toast
            window.ui.closeSidebar();
        } else if (window.deferredPrompt) {
            // Android: Trigger the install prompt
            window.deferredPrompt.prompt();
            window.deferredPrompt.userChoice.then((choiceResult) => {
                if (choiceResult.outcome === 'accepted') {
                    console.log('User accepted the install prompt');
                } else {
                    console.log('User dismissed the install prompt');
                }
                window.deferredPrompt = null;
            });
        }
    },

    updateHeaderProfile: function() {
        const headerAvatar = document.getElementById('header-avatar');
        const headerUsername = document.getElementById('header-username');
        const sidebarAvatar = document.getElementById('sidebar-avatar');
        const sidebarUsername = document.getElementById('sidebar-username');
        
        if (headerAvatar) {
            headerAvatar.innerText = window.game.state.userProfile.avatar;
            headerAvatar.className = `w-10 h-10 rounded-full flex items-center justify-center text-xl shadow-sm ${window.game.state.userProfile.avatarColor}`;
        }
        if (headerUsername) {
            headerUsername.innerText = window.game.state.userProfile.username;
        }
        if (sidebarUsername) {
            sidebarUsername.innerText = window.game.state.userProfile.username;
        }
        if (sidebarAvatar) {
            sidebarAvatar.innerText = window.game.state.userProfile.avatar;
            sidebarAvatar.className = `w-20 h-20 rounded-full flex items-center justify-center text-4xl shadow-md mx-auto mb-2 ${window.game.state.userProfile.avatarColor}`;
        }
    },

    updateAdminUI: function() {
        const adminPanel = document.getElementById('admin-panel');
        const adminBadge = document.getElementById('sidebar-admin-badge');
        const adminEmail = document.getElementById('admin-email');
        const adminTestModeToggle = document.getElementById('admin-test-mode-toggle');
        const adminTestModeLabel = document.getElementById('admin-test-mode-label');

        if (!window.game.state.isAdmin) {
            if (adminPanel) adminPanel.classList.add('hidden');
            if (adminBadge) adminBadge.classList.add('hidden');
            return;
        }

        if (adminPanel) adminPanel.classList.remove('hidden');
        if (adminBadge) adminBadge.classList.remove('hidden');
        if (adminEmail) adminEmail.innerText = window.game.state.user?.email || '';
        if (adminTestModeToggle) adminTestModeToggle.checked = !!window.game.state.adminTestMode;
        if (adminTestModeLabel) {
            adminTestModeLabel.innerText = window.game.state.adminTestMode
                ? 'Test Mode: ON (Scores not saved)'
                : 'Test Mode: OFF (Scores are saved)';
        }
    },

    toggleAdminTestMode: function(enabled) {
        if (!window.game.state.isAdmin || !window.game.state.user?.uid) return;
        window.game.state.adminTestMode = enabled;
        localStorage.setItem(`editor-admin-test-mode:${window.game.state.user.uid}`, enabled ? 'true' : 'false');
        this.updateAdminUI();
    },

    selectProfileEmoji: function(buttonEl, emoji) {
        // Remove border from all emoji buttons
        document.querySelectorAll('#profile-emoji-grid button').forEach(btn => {
            btn.classList.remove('border-indigo-500');
            btn.classList.add('border-transparent');
        });
        
        // Add border to selected button
        if (buttonEl) {
            buttonEl.classList.remove('border-transparent');
            buttonEl.classList.add('border-indigo-500');
        }
        
        // Update state
        window.game.state.userProfile.avatar = emoji;
        
        // Update live preview
        const livePreview = document.getElementById('modal-live-preview');
        if (livePreview) livePreview.innerText = emoji;
    },

    selectProfileColor: function(buttonEl, colorClass) {
        // Remove border-indigo-500 from all color swatches
        document.querySelectorAll('#profile-color-swatches button').forEach(btn => {
            btn.classList.remove('border-indigo-500');
            btn.classList.add('border-slate-200');
        });
        
        // Add border-indigo-500 to selected swatch
        if (buttonEl) {
            buttonEl.classList.remove('border-slate-200');
            buttonEl.classList.add('border-indigo-500');
        }
        
        // Update state
        window.game.state.userProfile.avatarColor = colorClass;
        
        // Update live preview
        const livePreview = document.getElementById('modal-live-preview');
        if (livePreview) {
            // Remove old color classes
            livePreview.classList.forEach(cls => {
                if (cls.startsWith('bg-')) livePreview.classList.remove(cls);
            });
            livePreview.classList.add(colorClass);
        }
    },

    initAccordion: function() {
        const accordion = document.getElementById('cheat-sheet-accordion');
        if (!accordion) return;

        accordion.addEventListener('click', (e) => {
            const header = e.target.closest('.accordion-header');
            if (!header) return;

            const item = header.parentElement;
            const currentlyActive = item.classList.contains('active');
            accordion.querySelectorAll('.accordion-item').forEach(el => el.classList.remove('active'));
            if (!currentlyActive) item.classList.add('active');
        });
    },

    saveProfile: function() {
        window.authEngine.saveProfile();
    }
};

// Listen for Firebase Auth State Changes (Safe to run now that window.game and window.ui exist)
onAuthStateChanged(auth, async (user) => {
    if (user) {
        window.game.state.isAdmin = isAdminUser(user);
        window.game.state.adminTestMode = user.uid ? localStorage.getItem(`editor-admin-test-mode:${user.uid}`) === 'true' : false;
        updateAuthUI(user);
        window.game.state.user = user;

        try {
            const docSnapshot = await getDoc(doc(db, 'users', user.uid));
            if (docSnapshot.exists()) {
                const profileData = docSnapshot.data();
                window.game.state.userProfile = {
                    username: profileData.username || user.displayName || 'Player',
                    avatar: profileData.avatar || '👤',
                    avatarColor: profileData.avatarColor || 'bg-gray-200',
                    publicTag: profileData.publicTag || '',
                    lastProfileChangeAt: profileData.lastProfileChangeAt || null
                };
                if (!window.game.state.userProfile.publicTag) {
                    const publicTag = await generateUniquePublicTag();
                    await setDoc(doc(db, 'users', user.uid), { publicTag }, { merge: true });
                    window.game.state.userProfile.publicTag = publicTag;
                }
                window.game.state.savedUserProfile = cloneUserProfile(window.game.state.userProfile);
                window.ui.updateHeaderProfile();
                window.ui.updateAdminUI();
            } else {
                const publicTag = await generateUniquePublicTag();
                window.game.state.userProfile = {
                    username: user.displayName || "Player",
                    avatar: "👤",
                    avatarColor: "bg-gray-200",
                    publicTag,
                    lastProfileChangeAt: null
                };
                window.game.state.savedUserProfile = cloneUserProfile(window.game.state.userProfile);
                await setDoc(doc(db, 'users', user.uid), {
                    username: window.game.state.userProfile.username,
                    avatar: window.game.state.userProfile.avatar,
                    avatarColor: window.game.state.userProfile.avatarColor,
                    publicTag,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }, { merge: true });
                window.ui.updateHeaderProfile();
                window.ui.updateAdminUI();
                window.ui.toggleModal('modal-profile', true);
            }
        } catch (error) {
            console.error("Profile fetch failed:", error);
            window.game.state.userProfile = {
                username: user.displayName || "Player",
                avatar: "👤",
                avatarColor: "bg-gray-200",
                publicTag: '',
                lastProfileChangeAt: null
            };
            window.game.state.savedUserProfile = cloneUserProfile(window.game.state.userProfile);
            window.ui.updateHeaderProfile();
            window.ui.updateAdminUI();
        }
    } else {
        window.game.state.user = null;
        window.game.state.isAdmin = false;
        window.game.state.adminTestMode = false;
        window.game.state.userProfile = {
            username: 'Guest Player',
            avatar: '👤',
            avatarColor: 'bg-slate-200',
            publicTag: '',
            lastProfileChangeAt: null
        };
        window.game.state.savedUserProfile = cloneUserProfile(window.game.state.userProfile);
        updateAuthUI(null);
        window.ui.updateHeaderProfile();
        window.ui.updateAdminUI();
    }
});

// Initialize
const initApp = () => {
    window.ui.initTheme();
    window.game.init();
};
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
