// chunk "cT" — clip/dissolve field
// source chars 908961..909347 of vendor\site\Da0XtQgu.js (verbatim template-literal body, ${...} interpolations preserved)
// ============================================================================

uniform float Q97;uniform vec3 Q92;uniform float Q98;uniform float Q96;uniform sampler2D Q94;uniform vec4 Q95;uniform float Q99;uniform float Q93;uniform vec3 Q91;float R223(vec3 R227,vec2 uv){if(Q97<0.5)return 0.0;float d=Q98-dot(R227,Q92);if(Q96>0.0){d+=Q96*texture2D(Q94,vec2(uv.x,1.0-uv.y)*Q95.xy+Q95.zw).r;}if(clamp(d*Q99,0.0,1.0)<0.01)discard;return clamp((Q93-d)*Q99,0.0,1.0);}

