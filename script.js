/* ==========================================================================
   LoveStory — Landing / Hero behaviour
   Keeps the existing login logic and page transitions, and adds one small
   enhancement: a subdued background parallax.
   ========================================================================== */

const enterButton = document.querySelector(".enter-button");
const loginButton = document.querySelector(".login-button");
const overlayModel = document.querySelector(".overlay-model");
const closeButton = document.querySelector(".close-button");
const loginForm = document.querySelector(".loginblock");
const usernameInput = document.querySelector(".logininput1");
const passwordInput = document.querySelector(".logininput2");
const submitLoginButton = document.querySelector(".login");
const errorMessage = document.querySelector(".login-error");

/* RETIRED.

   This page used to carry a passphrase in the source — two strings anyone who
   opened the file could read. Accounts now live on the server: bcrypt hashes,
   a session in an HttpOnly cookie, and at most two editors. The credentials
   that used to sit here have been removed rather than left in the repository.

   This file belongs to landing-legacy.html, which nothing links to any more.
   It is kept only so that page still renders; it is not a way into anything. */

/* Where the visitor goes after a successful login.
   The flow is Welcome -> Entrance (Memory Gallery) -> Main Story. */
const MEMORY_GALLERY_URL = "./gallery/index.html";

let lastFocusedElement = null;

/* --- open / close -------------------------------------------------------- */
function openLogin() {
    lastFocusedElement = document.activeElement;

    overlayModel.classList.add("show");
    clearError();

    /* Wait one frame so the dialog is actually displayed before focusing. */
    requestAnimationFrame(function () {
        usernameInput.focus();
    });
}

function closeLogin() {
    overlayModel.classList.remove("show");

    usernameInput.value = "";
    passwordInput.value = "";
    clearError();
    submitLoginButton.textContent = "LOGIN!";
    submitLoginButton.disabled = false;

    if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
        lastFocusedElement.focus();
    }
}

/* --- feedback ------------------------------------------------------------ */
function clearError() {
    errorMessage.textContent = "";
}

function showError(message) {
    errorMessage.textContent = message;
    passwordInput.value = "";
    passwordInput.focus();
}

/* --- submitting ---------------------------------------------------------- */
/* A real <form> means Enter works where it should, without hijacking Enter
   presses everywhere else on the page. */
loginForm.addEventListener("submit", function (event) {
    event.preventDefault();

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    /* There is no local passphrase to compare against any more. Attendance is
       settled by the server, so this retired page sends the visitor to the
       Entrance, which is the only real way in. */
    submitLoginButton.textContent = "REDIRECTING...";
    submitLoginButton.disabled = true;

    setTimeout(function () {
        window.location.href = MEMORY_GALLERY_URL;
    }, 800);
});

/* --- wiring -------------------------------------------------------------- */
enterButton.addEventListener("click", openLogin);
loginButton.addEventListener("click", openLogin);
closeButton.addEventListener("click", closeLogin);

/* Click the dark backdrop (but not the card itself) to dismiss. */
overlayModel.addEventListener("click", function (event) {
    if (event.target === overlayModel) {
        closeLogin();
    }
});

document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && overlayModel.classList.contains("show")) {
        closeLogin();
    }
});

/* Keep keyboard focus inside the dialog while it is open. */
overlayModel.addEventListener("keydown", function (event) {
    if (event.key !== "Tab") return;

    const focusable = overlayModel.querySelectorAll("button, input, [href]");
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
});

/* --------------------------------------------------------------------------
   Background parallax
   A few pixels of counter-movement, written to CSS custom properties that
   .hero__media consumes. One requestAnimationFrame per frame at most, and
   nothing at all for touch or reduced-motion visitors.
   -------------------------------------------------------------------------- */
(function () {
    const hero = document.querySelector(".hero");
    if (!hero) return;

    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!finePointer || reducedMotion) return;

    let ticking = false;
    let pointerX = 0;
    let pointerY = 0;

    window.addEventListener("mousemove", function (event) {
        /* -1 .. 1, measured from the centre of the window */
        pointerX = (event.clientX / window.innerWidth) * 2 - 1;
        pointerY = (event.clientY / window.innerHeight) * 2 - 1;

        if (ticking) return;
        ticking = true;

        requestAnimationFrame(function () {
            ticking = false;
            hero.style.setProperty("--px", (pointerX * -5).toFixed(2) + "px");
            hero.style.setProperty("--py", (pointerY * -4).toFixed(2) + "px");
        });
    });
})();
