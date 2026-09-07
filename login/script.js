const startButton = document.querySelector(".start-button");
const loginButton = document.querySelector(".login-button");
const overLayModel = document.querySelector(".overlay-model");
const closeButton = document.querySelector(".close-button");
const usernameInput = document.querySelector(".logininput1");
const passwordInput = document.querySelector(".logininput2");
const sumbitLoginbutton = document.querySelector(".login");
const correctUsername = "scarlett";
const correctPassword = "lovedream";

sumbitLoginbutton.addEventListener("click", function () {
    const username = usernameInput.value;
    const password = passwordInput.value;
    if (username === correctUsername && password === correctPassword) {
        sumbitLoginbutton.innerText = "LOGIN...";
        // sumbitLoginbutton.disabled = true;
        setTimeout(function () {
            window.location.href = "../mainpage/index.html";
        }, 800);
    } 
    else {
        alert("Password is not matched username! Please retry!");
    }
});

startButton.addEventListener("click", function () {
    openLogin();
});

loginButton.addEventListener("click", function () {
    openLogin();
});

closeButton.addEventListener("click", function () {
    closeLogin();
});

overLayModel.addEventListener("click", (e)=>{
    if(e.target === overLayModel) closeLogin();
});

document.addEventListener("keydown", (e)=>{
    if(e.key === "Escape") closeLogin();
});

document.addEventListener("keydown", (e)=>{
    if(e.key === "Enter") {
        sumbitLoginbutton.click();
    }
});

function openLogin() {
    overLayModel.classList.add("show")
};
function closeLogin() {
    overLayModel.classList.remove("show");
};
