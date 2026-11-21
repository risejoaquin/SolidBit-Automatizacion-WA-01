/**
 * Kapso official embedded inbox (inbox.kapso.ai/embed/{token}).
 * Worker embeds must be created by Kapso with assigned_user_id on the token.
 * UI ?handoff=1 is only a FILTER; it is NOT an authorization boundary.
 */
function safeEmbedUrl(raw){
  if(!raw)return null;
  try{
    const url=new URL(raw);
    if(url.protocol!=="https:" || url.username || url.password) return null;
    if(url.hostname!=="inbox.kapso.ai" || !/^\/embed\/[^/]+$/.test(url.pathname)) return null;
    return url;
  }catch{return null;}
}
export function resolveInboxEmbed(role,config={}){
  if(role!=="owner" && role!=="worker")return {available:false,reason:"Rol desconocido"};
  if(role==="worker" && (config.workerApproved!==true || !config.workerAssigneeId)){
    return {available:false,reason:"Pendiente certificado de embed restringido por assigned_user_id"};
  }
  const url=safeEmbedUrl(role==="worker"?config.workerEmbedUrl:config.ownerEmbedUrl);
  if(!url)return {available:false,reason:"Embed seguro de Kapso no configurado"};
  if(role==="worker"){
    url.searchParams.set("handoff","1");
    url.searchParams.set("status","active");
  }
  return {available:true,url:url.toString()};
}
