/**
 * App Folder presentation layer for the Home WebView.
 *
 * This module ports the mature Old ELIX App Folder interaction/visual language
 * without introducing another state owner. Folder state still lives in ctx.home;
 * this file only supplies renderer-side gesture reliability and presentation CSS.
 *
 * @module @deepseek-ai/dsh-home/app-folder-presentation
 */

/** Old-ELIX-derived App Folder presentation CSS layered over the generic Home renderer. */
export const APP_FOLDER_PRESENTATION_CSS = String.raw`
/* Respect semantic hidden state even when the base component uses flex/grid. */
.app-folder-name-editor[hidden],.app-folder-title[hidden]{display:none!important}

/* The desktop recedes; the folder itself stays optically sharp. */
.home-root>.wallpaper-frame,.home-root>.item-layer,.home-root>.widget-layer,.home-root>.home-empty{transition:filter 190ms cubic-bezier(.2,.84,.26,1),transform 285ms cubic-bezier(.18,.86,.24,1),opacity 190ms ease}
.home-root:has(>.app-folder-overlay)>.wallpaper-frame,.home-root:has(>.app-folder-overlay)>.item-layer,.home-root:has(>.app-folder-overlay)>.widget-layer,.home-root:has(>.app-folder-overlay)>.home-empty{filter:blur(18px) saturate(.78) brightness(.56);transform:scale(1.025);opacity:.72}

.app-folder-overlay{background:rgba(2,3,7,.17)!important;backdrop-filter:blur(11px) saturate(132%)!important;-webkit-backdrop-filter:blur(11px) saturate(132%)!important;padding:34px}
.app-folder-window{width:var(--folder-window-width,520px)!important;min-width:350px!important;max-width:min(780px,calc(100vw - 68px))!important;min-height:326px!important;max-height:var(--folder-window-max-height,min(710px,calc(100vh - 92px)))!important;background:linear-gradient(145deg,rgba(255,255,255,.17) 0%,rgba(255,255,255,.065) 34%,rgba(7,10,17,.34) 72%,rgba(5,7,12,.42) 100%)!important;backdrop-filter:blur(52px) saturate(188%) contrast(104%)!important;-webkit-backdrop-filter:blur(52px) saturate(188%) contrast(104%)!important;border:1px solid rgba(255,255,255,.23)!important;border-radius:34px!important;box-shadow:0 46px 120px -28px rgba(0,0,0,.9),0 1px 0 rgba(255,255,255,.48) inset,0 0 0 1px rgba(255,255,255,.055) inset!important;overflow:hidden;transform-origin:center center}
.app-folder-window::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 24% -12%,rgba(255,255,255,.23),transparent 43%),linear-gradient(115deg,rgba(255,255,255,.05),transparent 35%,rgba(255,255,255,.016) 72%,transparent);z-index:0}
.app-folder-window::after{content:"";position:absolute;left:34px;right:34px;top:0;height:1px;pointer-events:none;background:linear-gradient(90deg,transparent,rgba(255,255,255,.78),transparent);opacity:.8;z-index:5}
.app-folder-specular{display:none!important}

.app-folder-header{padding:22px 25px 8px!important;gap:4px!important;border-bottom:0!important;position:relative!important;z-index:2!important}
.app-folder-title-row{gap:9px!important}
.app-folder-title{font-size:20px!important;font-weight:650!important;letter-spacing:-.025em!important;padding:4px 7px!important;border-radius:11px!important;background:transparent!important;transition:transform 120ms cubic-bezier(.2,.84,.26,1),background-color 120ms ease!important}
.app-folder-title:hover{background:rgba(255,255,255,.07)!important;transform:translateY(-1px)}
.app-folder-title:active{transform:translateY(0) scale(.985)}
.app-folder-name-editor{align-items:center!important;gap:8px!important;flex:1!important}
.app-folder-name-input{height:34px!important;background:rgba(5,7,12,.42)!important;border:1px solid rgba(255,255,255,.23)!important;border-radius:11px!important;box-shadow:0 0 0 3px rgba(255,255,255,.055)!important;font-size:16px!important;transition:border-color 120ms ease,box-shadow 120ms ease!important}
.app-folder-name-input:focus{border-color:rgba(255,255,255,.42)!important;box-shadow:0 0 0 4px rgba(255,255,255,.075)!important}
.app-folder-name-save,.app-folder-manage,.app-folder-color-cycle,.app-folder-close{width:32px!important;height:32px!important;border-radius:11px!important;background:rgba(255,255,255,.06)!important;border:1px solid rgba(255,255,255,.11)!important;box-shadow:0 1px 0 rgba(255,255,255,.08) inset!important;transition:transform 120ms cubic-bezier(.2,.84,.26,1),background-color 120ms ease,border-color 120ms ease!important}
.app-folder-name-save:hover,.app-folder-manage:hover,.app-folder-color-cycle:hover{background:rgba(255,255,255,.15)!important;border-color:rgba(255,255,255,.24)!important;transform:translateY(-1px) scale(1.035)}
.app-folder-name-save:active,.app-folder-manage:active,.app-folder-color-cycle:active,.app-folder-close:active{transform:translateY(0) scale(.90)!important}
.app-folder-close:hover{transform:translateY(-1px) scale(1.035);background:rgba(248,113,113,.19)!important}
.app-folder-window.is-managing .app-folder-manage{background:rgba(255,255,255,.17)!important;border-color:rgba(255,255,255,.32)!important;box-shadow:0 0 0 1px rgba(255,255,255,.06),0 6px 20px rgba(0,0,0,.22)!important}
.app-folder-meta{height:0!important;opacity:0!important;overflow:hidden!important;padding-left:7px!important;transform:translateY(-3px);transition:height 150ms ease,opacity 150ms ease,transform 150ms ease!important}
.app-folder-window.is-managing .app-folder-meta{height:16px!important;opacity:1!important;transform:translateY(0)}
.app-folder-color-cycle{display:none!important}
.app-folder-window.is-managing .app-folder-color-cycle{display:grid!important;animation:elix-folder-control-enter 170ms cubic-bezier(.2,.84,.26,1)}
.app-folder-color-swatch{width:15px!important;height:15px!important;border-radius:50%!important;background:var(--folder-accent,rgba(255,255,255,.82))!important;border:1px solid rgba(255,255,255,.48)!important;box-shadow:0 2px 8px rgba(0,0,0,.34),0 0 0 2px rgba(255,255,255,.045)!important;transition:transform 140ms cubic-bezier(.2,.84,.26,1),box-shadow 140ms ease!important}
.app-folder-color-cycle:hover .app-folder-color-swatch{transform:scale(1.14);box-shadow:0 3px 10px rgba(0,0,0,.38),0 0 0 3px rgba(255,255,255,.065)!important}

.app-folder-page-frame{padding:14px 17px 16px!important;min-height:208px!important;border-top:0!important;z-index:2!important}
.app-folder-app-grid{grid-template-columns:repeat(auto-fit,minmax(min(5.5rem,28cqi),1fr))!important;gap:clamp(.55rem,2.6cqi,.95rem) clamp(.45rem,2cqi,.75rem)!important;padding:clamp(.55rem,2cqi,.85rem)!important;align-content:start!important}
.app-folder-app{min-width:0;padding:clamp(.4rem,1.8cqi,.7rem)!important;border-radius:17px!important;transition:background-color 120ms ease,transform 120ms cubic-bezier(.2,.84,.26,1),filter 120ms ease!important;transform-origin:center center}
.app-folder-app:hover{background:rgba(255,255,255,.075)!important;transform:translateY(-2px) scale(1.018)}
.app-folder-app:active{transform:translateY(0) scale(.94)!important}
.app-folder-icon-ring{inline-size:12cqi!important;block-size:auto!important;aspect-ratio:1!important;border-radius:clamp(.8rem,3.5cqi,1.15rem)!important;background:linear-gradient(145deg,rgba(255,255,255,.17),rgba(255,255,255,.035))!important;border:1px solid rgba(255,255,255,.17)!important;box-shadow:0 8px 20px rgba(0,0,0,.24),0 1px 0 rgba(255,255,255,.27) inset!important;transition:box-shadow 140ms ease,transform 140ms cubic-bezier(.2,.84,.26,1)!important}
.app-folder-app:hover .app-folder-icon-ring{box-shadow:0 11px 26px rgba(0,0,0,.28),0 1px 0 rgba(255,255,255,.34) inset!important;transform:scale(1.035)}
.app-folder-app-label{inline-size:100%!important;max-width:none!important;min-block-size:2.5em;margin-top:.5em!important;font-size:clamp(.72rem,2.8cqi,.95rem)!important;line-height:1.25!important;white-space:normal!important;overflow-wrap:anywhere!important}
.app-folder-page-arrow{width:30px!important;height:54px!important;border-radius:15px!important;background:transparent!important;color:rgba(255,255,255,.58)!important;transition:background-color 120ms ease,transform 140ms cubic-bezier(.2,.84,.26,1),opacity 120ms ease!important}
.app-folder-page-arrow:hover:not(:disabled){background:rgba(255,255,255,.08)!important;transform:scale(1.06)}
.app-folder-page-arrow:active:not(:disabled){transform:scale(.90)}
.app-folder-page-arrow:disabled{visibility:hidden!important}
.app-folder-pagination{gap:7px!important;padding:0 0 15px!important;z-index:2!important}
.app-folder-page-dot{width:5px!important;height:5px!important;background:rgba(255,255,255,.28)!important;transition:transform 140ms cubic-bezier(.2,.84,.26,1),background-color 120ms ease!important}
.app-folder-page-dot:hover{transform:scale(1.65)}
.app-folder-page-dot.is-active{background:rgba(255,255,255,.92)!important;box-shadow:none!important;transform:scale(1.35)!important}
.app-folder-footer{padding:10px 22px 18px!important;border-top:1px solid rgba(255,255,255,.05)!important;background:linear-gradient(180deg,transparent,rgba(0,0,0,.07))!important;z-index:2!important}
.app-folder-delete{border-radius:11px!important;background:rgba(239,68,68,.085)!important;border-color:rgba(248,113,113,.19)!important;padding:7px 13px!important;transition:transform 120ms cubic-bezier(.2,.84,.26,1),background-color 120ms ease!important}
.app-folder-delete:hover{transform:translateY(-1px) scale(1.02)}
.app-folder-delete:active{transform:translateY(0) scale(.96)}
.app-folder-remove-app{top:1px!important;right:2px!important;width:19px!important;height:19px!important;box-shadow:0 4px 12px rgba(0,0,0,.35)!important;animation:elix-folder-remove-control-enter 170ms cubic-bezier(.2,.84,.26,1)}
.app-folder-resize-grip::after{border-color:rgba(255,255,255,.28)!important;transition:border-color 120ms ease,transform 120ms cubic-bezier(.2,.84,.26,1)!important}
.app-folder-resize-grip:hover::after{border-color:rgba(255,255,255,.58)!important;transform:scale(1.18)}
.app-folder-window.is-drop-target{outline:2px solid rgba(255,255,255,.48);outline-offset:-5px;animation:elix-folder-target-breathe 680ms ease-in-out infinite alternate}
.app-folder-window.is-dissolving{pointer-events:none!important}

@keyframes elix-folder-control-enter{from{opacity:0;transform:scale(.68) rotate(-7deg)}to{opacity:1;transform:scale(1) rotate(0)}}
@keyframes elix-folder-remove-control-enter{from{opacity:0;transform:scale(.55)}to{opacity:1;transform:scale(1)}}
@keyframes elix-folder-target-breathe{from{outline-color:rgba(255,255,255,.30)}to{outline-color:rgba(255,255,255,.68)}}

@media (max-width:620px){.app-folder-overlay{padding:18px}.app-folder-window{width:min(var(--folder-window-width,520px),calc(100vw - 36px))!important;min-width:300px!important}}
@media (prefers-reduced-motion:reduce){.home-root>.wallpaper-frame,.home-root>.item-layer,.home-root>.widget-layer,.home-root>.home-empty{transition:none!important}.app-folder-app,.app-folder-color-cycle,.app-folder-remove-app,.app-folder-window.is-drop-target{transition:none!important;animation:none!important}}
`

/**
 * Single-click recognizer plus presentation-only Old ELIX motion. Authoritative mutations
 * remain renderer intents handled by ctx.home / FolderManager.
 */
export const APP_FOLDER_PRESENTATION_CLIENT_SCRIPT = String.raw`(function(){
"use strict";
var endpoint=location.pathname.replace(/\/$/,"");
var gesture=null;
var folderMutationAnimating=false;
var reduced=!!(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches);
function folderTile(target){return target&&target.closest?target.closest('.home-item[data-is-app-folder="true"]'):null;}
function post(intent){return fetch(endpoint+"/intent",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(intent),cache:"no-store",credentials:"same-origin"}).catch(function(){return undefined;});}
function openFolder(folderId){return post({type:"openFolder",folderId:folderId});}
function clearGesture(){gesture=null;}
document.addEventListener("pointerdown",function(event){if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;var tile=folderTile(event.target);if(!tile||tile.closest(".app-folder-overlay"))return;var id=tile.dataset.itemId;if(!id)return;gesture={pointerId:event.pointerId,id:id,startX:event.clientX,startY:event.clientY,moved:false};},true);
document.addEventListener("pointermove",function(event){if(!gesture||gesture.pointerId!==event.pointerId||gesture.moved)return;if(Math.hypot(event.clientX-gesture.startX,event.clientY-gesture.startY)>=8)gesture.moved=true;},true);
document.addEventListener("pointerup",function(event){if(!gesture||gesture.pointerId!==event.pointerId)return;var active=gesture;clearGesture();if(active.moved)return;var released=document.elementFromPoint(event.clientX,event.clientY),tile=folderTile(released);if(!tile||tile.dataset.itemId!==active.id)return;setTimeout(function(){openFolder(active.id);},0);},true);
document.addEventListener("pointercancel",clearGesture,true);

function animateClosingChildren(){var overlay=document.getElementById("app-folder-overlay"),win=document.getElementById("app-folder-window");if(!overlay||!win||reduced)return;var folderId=overlay.dataset.folderId,tile=folderId?document.querySelector('.home-item[data-item-id="'+CSS.escape(folderId)+'"]'):null,origin=tile?tile.getBoundingClientRect():win.getBoundingClientRect(),originCenterX=origin.left+origin.width/2,originCenterY=origin.top+origin.height/2;Array.from(win.querySelectorAll(".app-folder-app")).forEach(function(item,index){var rect=item.getBoundingClientRect(),dx=(originCenterX-(rect.left+rect.width/2))*.9,dy=(originCenterY-(rect.top+rect.height/2))*.9,motion=item.animate([{opacity:1,transform:"translate3d(0,0,0) scale(1)"},{opacity:0,transform:"translate3d("+dx+"px,"+dy+"px,0) scale(.28)"}],{duration:185,delay:Math.min(48,index*6),easing:"cubic-bezier(.45,0,.72,.2)",fill:"forwards"});motion.id="elix-folder-item-origin-close";});}

function animateRemoveApp(button,folderId,itemId){
  if(folderMutationAnimating)return;
  var app=button.closest(".app-folder-app");
  if(!app||reduced){post({type:"removeItemFromFolder",folderId:folderId,itemId:itemId});return;}
  folderMutationAnimating=true;
  app.style.pointerEvents="none";
  var motion=app.animate([
    {opacity:1,filter:"blur(0px)",transform:"translate3d(0,0,0) scale(1)"},
    {opacity:.78,transform:"translate3d(0,-5px,0) scale(1.06)",offset:.34},
    {opacity:0,filter:"blur(2px)",transform:"translate3d(0,18px,0) scale(.48)"}
  ],{duration:190,easing:"cubic-bezier(.35,0,.3,1)",fill:"forwards"});
  motion.id="elix-folder-remove-app-release";
  function finish(){post({type:"removeItemFromFolder",folderId:folderId,itemId:itemId}).finally(function(){folderMutationAnimating=false;});}
  if(motion.finished)motion.finished.then(finish).catch(finish);else setTimeout(finish,190);
}

function animateDissolve(folderId){
  if(folderMutationAnimating)return;
  var overlay=document.getElementById("app-folder-overlay"),win=document.getElementById("app-folder-window");
  if(!overlay||!win||reduced){post({type:"deleteFolder",folderId:folderId});return;}
  folderMutationAnimating=true;
  win.classList.add("is-dissolving");
  var apps=Array.from(win.querySelectorAll(".app-folder-app"));
  var center=win.getBoundingClientRect(),cx=center.left+center.width/2,cy=center.top+center.height/2;
  apps.forEach(function(app,index){var rect=app.getBoundingClientRect(),ax=rect.left+rect.width/2,ay=rect.top+rect.height/2,vx=ax-cx,vy=ay-cy,len=Math.max(1,Math.hypot(vx,vy)),distance=58+Math.min(46,index*3),dx=vx/len*distance,dy=vy/len*distance-8;var motion=app.animate([
    {opacity:1,filter:"blur(0px)",transform:"translate3d(0,0,0) scale(1)"},
    {opacity:1,transform:"translate3d("+(dx*.25)+"px,"+(dy*.25)+"px,0) scale(1.08)",offset:.32},
    {opacity:0,filter:"blur(2px)",transform:"translate3d("+dx+"px,"+dy+"px,0) scale(.72)"}
  ],{duration:260,delay:Math.min(70,index*12),easing:"cubic-bezier(.2,.74,.28,1)",fill:"forwards"});motion.id="elix-folder-dissolve-child";});
  var panel=win.animate([
    {opacity:1,transform:"scale(1)",filter:"blur(0px)"},
    {opacity:.88,transform:"scale(1.018)",offset:.28},
    {opacity:0,transform:"scale(.82)",filter:"blur(7px)"}
  ],{duration:300,easing:"cubic-bezier(.32,0,.45,1)",fill:"forwards"});
  panel.id="elix-folder-dissolve-panel";
  overlay.animate([{opacity:1},{opacity:0}],{duration:280,easing:"ease-out",fill:"forwards"});
  function finish(){post({type:"deleteFolder",folderId:folderId}).finally(function(){folderMutationAnimating=false;});}
  if(panel.finished)panel.finished.then(finish).catch(finish);else setTimeout(finish,300);
}

/* Intercept mutating controls in capture phase so animation finishes before the base client mutates state. */
document.addEventListener("pointerdown",function(event){
  var overlay=document.getElementById("app-folder-overlay");if(!overlay)return;
  var folderId=overlay.dataset.folderId;if(!folderId)return;
  var remove=event.target.closest('[data-folder-action="remove-app"]');
  if(remove){var itemId=remove.dataset.appId;if(!itemId)return;event.preventDefault();event.stopImmediatePropagation();animateRemoveApp(remove,folderId,itemId);return;}
  var dissolve=event.target.closest('[data-folder-action="delete"]');
  if(dissolve){event.preventDefault();event.stopImmediatePropagation();animateDissolve(folderId);return;}
  if(event.target===overlay||event.target.closest('[data-folder-action="close"]'))animateClosingChildren();
},true);

document.addEventListener("keydown",function(event){if(event.key==="Escape"&&document.getElementById("app-folder-overlay"))animateClosingChildren();},true);
})();`

/** Inject App Folder presentation assets into the otherwise generic Home document. */
export function decorateHomeDocument(document: string, nonce: string): string {
  const withStyles = document.replace('</style>', APP_FOLDER_PRESENTATION_CSS + '</style>')
  return withStyles.replace(
    '</body>',
    '<script nonce="' + nonce + '">' + APP_FOLDER_PRESENTATION_CLIENT_SCRIPT + '</script></body>',
  )
}
