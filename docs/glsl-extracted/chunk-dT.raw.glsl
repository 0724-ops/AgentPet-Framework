// chunk "dT" — helpers (R205 saturation, R200 base)
// source chars 924236..924484 of vendor\site\Da0XtQgu.js (verbatim template-literal body, ${...} interpolations preserved)
// ============================================================================

vec3 R205(vec3 c,float s){float l=dot(c,vec3(0.2126,0.7152,0.0722));return max(mix(vec3(l),c,s),0.0);}vec4 R200(sampler2D map,vec3 color,float opacity,vec2 uv){vec4 base=vec4(color,opacity);
#ifdef Q8
base*=texture2D(map,uv);
#endif
return base;}

