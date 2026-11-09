// template literal at char 908960..909347  body length 386  glsl-marker-hits 9
// context before: "olor=vec4(mix(vec3(1.0),Q261.rgb,v),1.0);\n#include <colorspace_fragment>\n}\n`;function HB(){return{Q97:{value:0},Q92:{value:new C},Q98:{value:0},Q96:{value:0},Q94:{value:null},Q95:{value:new ze(1,1,0,0)},Q99:{value:1},Q93:{value:0},Q91:{value:new ce}}}const cT="
// context after : ";function uT(s,e){const t=s[0],n=s[s.length-1];if(e<=t[0])return t[1];if(e>=n[0])return n[1];let i=0;for(;s[i+1][0]<e;)i++;const[r,o,,a]=s[i],[l,c,u]=[s[i+1][0],s[i+1][1],s[i+1][2]],h=l-r,d=(e-r)/h,f"
// ======================================================================

uniform float Q97;uniform vec3 Q92;uniform float Q98;uniform float Q96;uniform sampler2D Q94;uniform vec4 Q95;uniform float Q99;uniform float Q93;uniform vec3 Q91;float R223(vec3 R227,vec2 uv){if(Q97<0.5)return 0.0;float d=Q98-dot(R227,Q92);if(Q96>0.0){d+=Q96*texture2D(Q94,vec2(uv.x,1.0-uv.y)*Q95.xy+Q95.zw).r;}if(clamp(d*Q99,0.0,1.0)<0.01)discard;return clamp((Q93-d)*Q99,0.0,1.0);}

