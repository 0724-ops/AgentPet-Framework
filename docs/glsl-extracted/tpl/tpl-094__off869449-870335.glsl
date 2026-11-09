// template literal at char 869449..870335  body length 885  glsl-marker-hits 2
// context before: "rn,WebGLRenderer:gS,WebGLUtils:pS,WebGPUCoordinateSystem:Ic,WireframeGeometry:IS,WrapAroundEnding:Cc,ZeroCurvatureEnding:to,ZeroFactor:rh,ZeroSlopeEnding:no,ZeroStencilOp:dI,createCanvasElement:nS},Symbol.toStringTag,{value:\"Module\"}));ot.tonemapping_fragment="
// context after : ";function yx(s){return async()=>{const e=await fetch(s);if(!e.ok)throw new Error(`${s}: ${e.status}`);return e.arrayBuffer()}}function nT(s){var n,i,r;const e=s.json.textures??[],t=new Map;for(const["
// ======================================================================

#ifndef Q24
{const vec3 R105=vec3(0.272229,0.674082,0.053689);vec3 R106=gl_FragColor.rgb;vec3 R113=max(vec3(dot(vec3(0.613192,0.339512,0.047366),R106),dot(vec3(0.070206,0.916336,0.013450),R106),dot(vec3(0.020619,0.109568,0.869606),R106)),0.0);float R111=clamp(dot(R105,R113)/0.3,0.0,1.0);R113*=1.0-0.105*(1.0-R111*R111*(3.0-2.0*R111));float R107=dot(R105,R113);R113=max(R107+1.08*(R113-R107),0.0);vec3 R114=min(R113*(2.785085*R113+0.107772)/max(R113*(2.936045*R113+0.887122)+0.806889,1e-4),1.0);float R108=dot(R105,R114);R114=R108+0.93*(R114-R108);vec3 R110=vec3(dot(vec3(1.705052,-0.621791,-0.083259),R114),dot(vec3(-0.130257,1.140803,-0.010548),R114),dot(vec3(-0.024003,-0.128969,1.152972),R114));float R112=clamp((dot(R105,R113)-0.5)/1.5,0.0,1.0);vec3 R109=clamp(R110/max(max(R110.r,max(R110.g,R110.b)),1e-5),0.0,1.0);gl_FragColor.rgb=clamp(R110+R112*(R109-R110),0.0,1.0);}
#endif

