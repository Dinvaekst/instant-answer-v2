const BACKEND_URL = "https://instant-answer-backend-clean.onrender.com";

const ASK_URL = `${BACKEND_URL}/ask`;
const CHECK_PRO_URL = `${BACKEND_URL}/check-pro`;

let activeMode = "chat";
let isGenerating = false;

let currentPageText = "";
let currentPageType = "";

let uploadedPdfFile = null;
let uploadedImageFile = null;

function $(id){
  return document.getElementById(id);
}

function escapeHTML(text=""){
  return String(text)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;");
}

function formatAnswer(text=""){
  return escapeHTML(text).replace(/\n/g,"<br>");
}

function getDeviceId(){
  let id = localStorage.getItem("ia_device");

  if(!id){
    id = crypto.randomUUID();
    localStorage.setItem("ia_device", id);
  }

  return id;
}

function setLoading(text="Thinking..."){
  $("result").innerHTML = `
    <div class="loading">
      <div>
        ${text}
        <div class="typing-dots">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </div>
  `;
}

function showAnswer(title, answer){
  $("result").innerHTML = `
    <div class="answer-box">
      <div class="answer-label">${activeMode.toUpperCase()}</div>
      <div class="answer-title">${title}</div>
      <div class="answer-content">${formatAnswer(answer)}</div>
    </div>
  `;
}

function resetUI(){
  document.querySelectorAll(".mode-tab").forEach(btn=>{
    btn.classList.remove("active");
  });

  document.querySelectorAll(".mode-tools").forEach(el=>{
    el.style.display = "none";
  });

  $("pdfUploadBox").style.display = "none";
  $("imageUploadBox").style.display = "none";
}

function setMode(mode){
  activeMode = mode;

  resetUI();

  if(mode === "chat"){
    $("chatModeBtn").classList.add("active");

    $("panelTitle").textContent = "Chat Mode";
    $("panelSubtitle").textContent = "Ask anything.";

    $("mainInput").placeholder = "Ask anything...";
  }

  if(mode === "page"){
    $("pageModeBtn").classList.add("active");

    $("panelTitle").textContent = "Page Mode";
    $("panelSubtitle").textContent = "Analyze websites and browser pages.";

    $("pageTools").style.display = "grid";

    $("mainInput").placeholder = "Ask about this page...";
  }

  if(mode === "study"){
    $("studyModeBtn").classList.add("active");

    $("panelTitle").textContent = "Study Mode";
    $("panelSubtitle").textContent = "Simple explanations and learning.";

    $("mainInput").placeholder = "What do you want explained?";
  }

  if(mode === "math"){
    $("mathModeBtn").classList.add("active");

    $("panelTitle").textContent = "Math Mode";
    $("panelSubtitle").textContent = "Solve math step-by-step.";

    $("mathTools").style.display = "grid";

    $("mainInput").placeholder = "Solve equation...";
  }

  if(mode === "files"){
    $("filesModeBtn").classList.add("active");

    $("panelTitle").textContent = "Files Mode";
    $("panelSubtitle").textContent = "Analyze PDFs and images.";

    $("filesTools").style.display = "grid";
    $("pdfUploadBox").style.display = "block";
    $("imageUploadBox").style.display = "block";

    $("mainInput").placeholder = "Ask about your file...";
  }
}

async function askAI(input){

  const response = await fetch(ASK_URL,{
    method:"POST",
    headers:{
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      input,
      mode:activeMode,
      deviceId:getDeviceId()
    })
  });

  const data = await response.json();

  if(!response.ok){
    throw new Error(data.error || "Server error");
  }

  return data;
}

async function loadCurrentPage(){

  try{

    const [tab] = await chrome.tabs.query({
      active:true,
      currentWindow:true
    });

    const results = await chrome.scripting.executeScript({
      target:{ tabId:tab.id },
      function:()=>{
        return {
          title:document.title,
          text:document.body.innerText.slice(0,12000),
          url:location.href
        };
      }
    });

    const page = results?.[0]?.result;

    currentPageText = page.text;
    currentPageType = page.url;

    $("pageStatus").textContent = page.title.slice(0,40);

  }catch(err){
    console.error(err);
  }
}

async function runMainAction(){

  if(isGenerating) return;

  const text = $("mainInput").value.trim();

  if(!text && activeMode !== "page"){
    return;
  }

  isGenerating = true;

  setLoading();

  try{

    let finalPrompt = text;

    if(activeMode === "page"){

      await loadCurrentPage();

      finalPrompt = `
Current page:
${currentPageText}

User question:
${text}
`;
    }

    const data = await askAI(finalPrompt);

    showAnswer("Instant Answer", data.answer);

  }catch(error){

    console.error(error);

    showAnswer(
      "Error",
      error.message || "Something went wrong."
    );

  }finally{
    isGenerating = false;
  }
}

function clearChat(){

  $("result").innerHTML = `
    <div class="loading">
      Ready
    </div>
  `;

  $("mainInput").value = "";
}

document.addEventListener("DOMContentLoaded",()=>{

  setMode("chat");

  $("chatModeBtn").onclick = ()=>setMode("chat");
  $("pageModeBtn").onclick = ()=>setMode("page");
  $("studyModeBtn").onclick = ()=>setMode("study");
  $("mathModeBtn").onclick = ()=>setMode("math");
  $("filesModeBtn").onclick = ()=>setMode("files");

  $("mainActionBtn").onclick = runMainAction;

  $("clearBtn").onclick = clearChat;

  $("mainInput").addEventListener("keydown",(e)=>{

    if(e.key === "Enter" && !e.shiftKey){
      e.preventDefault();
      runMainAction();
    }

  });

});