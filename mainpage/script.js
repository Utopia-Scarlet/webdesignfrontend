const prev = document.querySelector(".prev");
const next = document.querySelector(".next");
const track = document.querySelector(".slider1track");
const slider1 = document.querySelector(".slider1");

const prev2 = document.querySelector(".prev2");
const next2 = document.querySelector(".next2");
const track2 = document.querySelector(".slider2track");
const slider2 = document.querySelector(".slider2");

const loading = document.querySelector(".background-loading");
// const revealmask = document.querySelector(".reveal-mask");
const reveal_mask = document.querySelector(".reveal-mask");

let currentIndex = 0;
let imageWidth = 250;
let autoplay = setInterval(nextupdated,3000);

let currentIndex2 = 0;
let imageWidth2 = 250;
let autoplay2 = setInterval(nextupdated2, 3000);

// setTimeout(function(){
//     loading.style.opacity = "0";
// }, 2000);

// setTimeout(function(){
    
// }, 2000);

setTimeout(function(){
    loading.style.display = "none";
    reveal_mask.classList.add("show");
}, 2000);

setTimeout(function(){
    reveal_mask.style.display = "none";
}, 3500);


// setTimeout(function(){
//     loading.classList.add = ("active");
// }, 1000);

// 如果有这个语句，那么整个main页面都会display = none，主页面就会消失
// setTimeout(function(){
//     pagereveal.style.display = "none";
// }, 3000);

function updateslider(){
    track.style.transform = `translateX(-${currentIndex*imageWidth}px)`;
}
next.addEventListener("click", function(){
    nextupdated();
});
prev.addEventListener("click", function(){
    prevupdated();
});
function nextupdated(){
    currentIndex = currentIndex+1;
    if (currentIndex> 5)
        currentIndex = 0;
    updateslider();
}
function prevupdated(){
    currentIndex = currentIndex -1;
    if (currentIndex<0)
        currentIndex = 5;
    updateslider();
}

function updateslider2(){
    track2.style.transform = `translateX(-${currentIndex2 * imageWidth2}px)`;
}

next2.addEventListener("click", function(){
    nextupdated2();
});
prev2.addEventListener("click", function(){
    prevupdated2();
});

function nextupdated2(){
    currentIndex2 = currentIndex2 + 1;
    if (currentIndex2 > 8)
        currentIndex2 = 0;
    updateslider2();
};
function prevupdated2(){
    currentIndex2 = currentIndex2 - 1;
    if(currentIndex2 < 0)
        currentIndex2 = 8;
    updateslider2();
};

// setInterval(function(){
//     nextupdated();
// },3000
// );

slider1.addEventListener("mouseenter", function(){
    clearInterval(autoplay);
});
slider1.addEventListener("mouseleave", function(){
    autoplay = setInterval(nextupdated,3000)
});

slider2.addEventListener("mouseenter", function(){
    clearInterval(autoplay2);
});
slider2.addEventListener("mouseleave", function(){
    autoplay2 = setInterval(nextupdated2,3000)
});