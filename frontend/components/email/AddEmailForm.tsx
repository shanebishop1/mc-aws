"use client";

import { useState } from "react";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AddEmailFormProps {
  onAdd: (email: string) => void;
  disabled: boolean;
}

export const AddEmailForm = ({ onAdd, disabled }: AddEmailFormProps) => {
  const [newEmail, setNewEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    const trimmed = newEmail.trim().toLowerCase();
    if (!trimmed) return;

    if (!EMAIL_REGEX.test(trimmed)) {
      setError("Invalid email format");
      return;
    }

    setError(null);
    onAdd(trimmed);
    setNewEmail("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="email"
          value={newEmail}
          onChange={(e) => {
            setNewEmail(e.target.value);
            setError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder="email@example.com"
          disabled={disabled}
          className="flex-1 px-3 py-2 font-sans text-sm bg-white border border-luxury-black/20 rounded-sm focus:outline-none focus:border-luxury-green disabled:opacity-50"
        />
        <button
          type="button"
          onClick={handleAdd}
          disabled={disabled || !newEmail.trim()}
          className="px-4 py-2 font-sans text-sm text-white bg-luxury-green rounded-sm hover:bg-luxury-green/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          Add
        </button>
      </div>
      {error && (
        <p className="font-sans text-xs text-red-500">{error}</p>
      )}
    </div>
  );
}
