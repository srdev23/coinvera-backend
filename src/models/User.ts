// models/User.ts
import mongoose from "mongoose";

interface Plan {
    apiKey: string;
    level: 'free' | 'pro' | 'advanced';
    credits: number;
    from_t: Date;
    to_t: Date
}
  
interface User extends mongoose.Document {
    name: string;
    email: string;
    password: string;
    role: 'user' | 'admin';
    plan: Plan;
    createdAt: Date;
    isValidPassword: (password: string) => Promise<boolean>;
}

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true,
    validate: {
      validator: (v: string) =>
        /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/.test(v),
      message: (props: any) => `${props.value} is not a valid email address!`,
    }
  },
  password: { type: String, default: "" },
  role: { type: String, enum: ["user", "admin"], default: "user" },
  plan: {
    apiKey: { type: String, required: true, unique: true },
    level: { type: String, enum: ["free", "pro", "advanced"], default: "free" },
    credits: { type: Number, default: 0 },
    from_t: { type: Date, default: Date.now },
    to_t: { type: Date, default: Date.now },
  },
  createdAt: { type: Date, default: Date.now },
},
{ timestamps: true }
);

// const User = mongoose.model<User>("User", UserSchema);
const User = mongoose.models.User || mongoose.model("User", UserSchema);

export default User;
