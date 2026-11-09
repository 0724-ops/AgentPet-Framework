// chunk "f4" — character point-light loop (R43)
// source chars 925460..927005 of vendor\site\Da0XtQgu.js (verbatim template-literal body, ${...} interpolations preserved)
// ============================================================================

#define Q25 ${bx}
#if defined(Q6) && defined(Q9)
#define Q0
#endif
uniform int Q60;uniform vec4 Q63[Q25];uniform vec4 Q58[Q25];uniform vec4 Q61[Q25];uniform vec4 Q59[Q25];uniform vec4 Q62[Q25];float R42(float x){x=clamp(x,0.0,1.0);return x*x*(3.0-2.0*x);}vec3 R43(vec3 N,vec3 R20,vec3 R19,vec3 V,vec3 R174,vec3 R45,float F,float R129){vec3 sum=vec3(0.0);vec3 Z=vec3(viewMatrix[0][2],viewMatrix[1][2],viewMatrix[2][2]);float u=1.0-abs(dot(N,V));
#ifdef Q0
const float R34=0.5;
#else
const float R34=0.25;
#endif
for(int i=0;i<Q25;i++){if(i>=Q60)break;vec4 P=Q63[i];vec4 D=Q61[i];vec4 cone=Q59[i];vec4 R135=Q62[i];vec3 C=Q58[i].rgb;vec3 R10=P.xyz-Q326;float d2=max(dot(R10,R10),1e-8);vec3 L=R10*inversesqrt(d2);float t=d2*P.w*P.w;float A;if(D.w<0.0){float w=max(1.0-t*t,0.0);A=w*w/(d2+1.0);}else{A=pow(max(1.0-min(t,1.0),0.0),D.w);}if(cone.z>0.5){float c=clamp((dot(L,-D.xyz)-cone.x)*cone.y,0.0,1.0);A*=c*c;}if(A<=0.0001)continue;if(Q58[i].w<0.5){vec3 AC=A*C;float n=(1.0-R135.y)+R135.y/max(max(AC.r,max(AC.g,AC.b))*0.75,1.0);float wrap=R34*R135.x+(1.0-R34*R135.x)*clamp(dot(R20,L)+0.5,0.0,1.0);sum+=AC*n*wrap*R174;
#if defined(Q5) && defined(Q7)
sum+=R93(normalize(L+V))*R92*AC;
#endif
}else{vec3 R21=cross(Z,cross(Z,L));float pl=length(R21);float w=pl>1e-5?clamp(dot(N,-R21/pl),0.0,1.0):0.0;float S=clamp(dot(R19,L)+1.0,0.0,1.0);float band=R42((u-(0.8-0.6*R135.x))/(0.1+0.2*R135.x));
#ifdef Q0
float R160=mix(band*F,F*R129,clamp(10.0*R135.x-3.0,0.0,1.0))*S;
#else
float R160=band*S;
#endif
sum+=A*R160*C*w*(0.5+R135.y*(R45-0.5));}}return sum;}

